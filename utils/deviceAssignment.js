// The ONE place that moves a device between ponds. Every endpoint that can
// change monitoring_devices.pond_id (PUT /devices/:id, POST /devices/:id/assign,
// PUT /devices/:id/pond, POST /devices) goes through this file, so they all
// behave the same way:
//
//   * runs in a transaction, so a half-finished move can never be left behind;
//   * a pond holds AT MOST ONE device. If the target pond already has a device
//     it is unassigned (and reported as `displaced_device`) instead of leaving
//     two devices in one pond;
//   * stamps assigned_at, so the API knows which readings belong to the new
//     assignment;
//   * the pond the device LEFT has no device any more, so it is OFFLINE in the
//     very next API answer, and the pond it ENTERED is online straight away
//     (see utils/pondState.js).
//
// Registering a device (registerDevice) and removing one from a farm
// (unregisterDevice) live here too because they also change the pond
// assignment, and they reuse exactly the same move step:
//
//   registerDevice    the farmer typed the Device ID + Device Key printed on the
//                     box and chose a pond. In ONE transaction: the device must
//                     exist, the key must match, and the device must not belong
//                     to any farm yet; then it is claimed for the farm and put in
//                     the pond. Nothing is generated: the credentials were set
//                     when the device was provisioned (utils/deviceProvisioning.js).
//   unregisterDevice  takes the device out of the farm and out of its pond. The
//                     row, its permanent credentials, its readings and its status
//                     are kept, so the same device can be registered again.
const pool = require('../db');
const { pondSnapshot } = require('./pondState');
const { OFFLINE_TITLE } = require('./deviceHealth');
const { keysMatch } = require('./deviceProvisioning');

class AssignmentError extends Error {
  // `code` is an optional machine-readable reason the app can act on.
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

// The same words for every wrong Device ID / Device Key, whichever of the two
// was wrong, so nobody can probe which Device IDs exist.
const BAD_CREDENTIALS_MESSAGE =
  'No HyQual device matches that Device ID and Device Key. Check both against the label on the device box and try again.';

// Runs fn(conn) in one transaction: commits when it returns, rolls back when it throws.
async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

// Two people moving devices at the same moment can deadlock each other in the
// database (or race for the same pond); one of them is rolled back and simply
// tries again.
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw lastErr;
}

// Moves a device that is already loaded AND locked (SELECT ... FOR UPDATE) by
// the caller's transaction into pondId, or unassigns it when pondId is null.
// `device` needs device_id, device_name and pond_id.
async function moveInTransaction(conn, { device, farmId, pondId }) {
  let target = null;
  if (pondId !== null) {
    const id = Number(pondId);
    // Scoped to the caller's farm: another farm's pond answers exactly like
    // a pond that does not exist (no id probing).
    const [ponds] = await conn.query(
      'SELECT pond_id, pond_name FROM ponds WHERE pond_id = ? AND farm_id = ? FOR UPDATE',
      [Number.isInteger(id) ? id : 0, farmId]
    );
    if (!ponds.length) throw new AssignmentError(404, 'Pond not found in your farm');
    target = ponds[0];
  }

  let previousPondName = null;
  if (device.pond_id) {
    const [prev] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [device.pond_id]);
    previousPondName = prev[0]?.pond_name ?? null;
  }

  const result = {
    device_id: device.device_id,
    device_name: device.device_name,
    pond_id: target ? target.pond_id : null,
    pond_name: target ? target.pond_name : null,
    previous_pond_id: device.pond_id ?? null,
    previous_pond_name: previousPondName,
    changed: false,
    displaced_device: null,
  };

  const same = (device.pond_id ?? null) === (target ? target.pond_id : null);
  if (same) return result;

  if (target) {
    const [occupants] = await conn.query(
      'SELECT device_id, device_name FROM monitoring_devices WHERE pond_id = ? AND device_id <> ? FOR UPDATE',
      [target.pond_id, device.device_id]
    );
    if (occupants.length) {
      await conn.query(
        'UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE pond_id = ? AND device_id <> ?',
        [target.pond_id, device.device_id]
      );
      result.displaced_device = { device_id: occupants[0].device_id, device_name: occupants[0].device_name };
    }
    await conn.query(
      'UPDATE monitoring_devices SET pond_id = ?, assigned_at = NOW() WHERE device_id = ?',
      [target.pond_id, device.device_id]
    );
  } else {
    await conn.query(
      'UPDATE monitoring_devices SET pond_id = NULL, assigned_at = NULL WHERE device_id = ?',
      [device.device_id]
    );
  }

  result.changed = true;
  return result;
}

async function tryAssign({ deviceId, farmId, pondId }) {
  return inTransaction(async (conn) => {
    const [devs] = await conn.query(
      'SELECT device_id, device_name, pond_id FROM monitoring_devices WHERE device_id = ? AND farm_id = ? FOR UPDATE',
      [deviceId, farmId]
    );
    if (!devs.length) throw new AssignmentError(404, 'Device not found');
    return moveInTransaction(conn, { device: devs[0], farmId, pondId });
  });
}

// pondId: a pond id to move the device into, or null to unassign it.
async function assignDevice({ deviceId, farmId, pondId }) {
  return withRetry(() => tryAssign({ deviceId, farmId, pondId }));
}

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

async function tryRegister({ deviceId, deviceKey, farmId, pondId, deviceName }) {
  return inTransaction(async (conn) => {
    // Lock the device row first (same order as tryAssign: device, pond, occupant),
    // so two farmers registering the same device at the same moment are handled
    // one after the other and only the first can win.
    const [devs] = await conn.query(
      'SELECT device_id, device_name, device_key, farm_id, pond_id FROM monitoring_devices WHERE device_id = ? FOR UPDATE',
      [deviceId]
    );
    const device = devs[0];
    if (!device || !keysMatch(device.device_key, deviceKey)) {
      throw new AssignmentError(404, BAD_CREDENTIALS_MESSAGE, 'DEVICE_CREDENTIALS_INVALID');
    }

    // The credentials are right, so it is safe to say more about WHY it cannot be registered.
    if (device.farm_id !== null && device.farm_id !== undefined) {
      if (Number(device.farm_id) === Number(farmId)) {
        let where = '';
        if (device.pond_id) {
          const [p] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [device.pond_id]);
          if (p.length) where = ` (on ${p[0].pond_name})`;
        }
        throw new AssignmentError(
          409,
          `${device.device_name} is already registered in your farm${where}. To use it in another pond, open Devices and choose Manage on it.`,
          'DEVICE_ALREADY_REGISTERED'
        );
      }
      throw new AssignmentError(
        409,
        'This device is already registered to another account. Its current owner has to remove it from their account before it can be registered again.',
        'DEVICE_ALREADY_REGISTERED'
      );
    }

    // Claim it for this farm (and give it the name the farmer typed, if any; without
    // one it keeps its default "Device <id>"). The WHERE guard makes "only if still
    // unregistered" explicit.
    const [claimed] = await conn.query(
      'UPDATE monitoring_devices SET farm_id = ?, device_name = COALESCE(?, device_name), installed_at = NOW() WHERE device_id = ? AND farm_id IS NULL',
      [farmId, deviceName || null, device.device_id]
    );
    if (!claimed.affectedRows) {
      throw new AssignmentError(409, 'This device was just registered by someone else.', 'DEVICE_ALREADY_REGISTERED');
    }

    // Put it in the chosen pond with the same step every other move uses
    // (stamps assigned_at, enforces one device per pond).
    // (An unregistered device has no pond, so this is always a fresh assignment.)
    const move = await moveInTransaction(conn, {
      device: { ...device, farm_id: farmId, pond_id: null, device_name: deviceName || device.device_name },
      farmId,
      pondId,
    });

    // Every device has exactly one current-status row. Provisioning creates it;
    // this only fills it in if it is missing, and never touches a device that
    // is already reporting.
    await conn.query(
      `INSERT INTO device_status (device_id, connectivity_status, active_sensors_count, recorded_at, last_seen_at)
       VALUES (?, 'offline', 0, NOW(), NULL)
       ON DUPLICATE KEY UPDATE device_id = device_id`,
      [device.device_id]
    );
    return move;
  });
}

// Best effort: a failed log line must never undo or block a registration.
async function logDeviceEvent(accountId, actionType, description) {
  if (!accountId) return;
  try {
    await pool.query(
      'INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, ?, ?)',
      [accountId, actionType, description]
    );
  } catch (err) {
    console.error('Could not write activity log:', err.code || err.message);
  }
}

// deviceId: the printed Device ID (a positive integer). deviceKey: the printed
// Device Key. pondId: the pond chosen in the app (must be one of farmId's ponds).
// deviceName: optional name for the device (already trimmed and length-checked by
// the route); without it the device keeps its default "Device <id>".
// Resolves with the same shape as assignDevice (device_id, device_name, pond_id,
// pond_name, displaced_device ...). Never resolves with, or logs, the key.
// Rejects with an AssignmentError: 404 DEVICE_CREDENTIALS_INVALID,
// 404 (pond not in this farm) or 409 DEVICE_ALREADY_REGISTERED.
async function registerDevice({ deviceId, deviceKey, farmId, pondId, accountId, deviceName }) {
  // Cheap check first, without locking anything, so wrong or guessed
  // credentials are turned away before a transaction is opened.
  const [pre] = await pool.query('SELECT device_key FROM monitoring_devices WHERE device_id = ?', [deviceId]);
  if (!pre.length || !keysMatch(pre[0].device_key, deviceKey)) {
    throw new AssignmentError(404, BAD_CREDENTIALS_MESSAGE, 'DEVICE_CREDENTIALS_INVALID');
  }

  const move = await withRetry(() => tryRegister({ deviceId, deviceKey, farmId, pondId, deviceName }));
  await logDeviceEvent(
    accountId,
    'device_registered',
    `Registered device #${move.device_id} (${move.device_name}) to pond "${move.pond_name}" (farm #${farmId}).`
  );
  return move;
}

// ---------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------

async function tryUnregister({ deviceId, farmId }) {
  return inTransaction(async (conn) => {
    const [devs] = await conn.query(
      'SELECT device_id, device_name, pond_id FROM monitoring_devices WHERE device_id = ? AND farm_id = ? FOR UPDATE',
      [deviceId, farmId]
    );
    if (!devs.length) throw new AssignmentError(404, 'Device not found');
    const device = devs[0];

    let previousPondName = null;
    if (device.pond_id) {
      const [prev] = await conn.query('SELECT pond_name FROM ponds WHERE pond_id = ?', [device.pond_id]);
      previousPondName = prev[0]?.pond_name ?? null;
    }

    // Back to "provisioned, not registered": no farm, no pond, and the default name
    // again so one farm's custom name is not handed to the next owner. device_id and
    // device_key are NOT touched: they are permanent. Readings keep their device_id and pond_id.
    await conn.query(
      `UPDATE monitoring_devices
          SET farm_id = NULL, pond_id = NULL, assigned_at = NULL, status = 'active',
              device_name = CONCAT('Device ', device_id)
        WHERE device_id = ?`,
      [device.device_id]
    );

    // The farm's alerts stay as its history, but they stop pointing at a device
    // that can now belong to somebody else (the same as when a device row used to be
    // deleted), and a "Device Offline" alert for a device the farmer removed is over.
    await conn.query(
      `UPDATE early_warning_notifications SET is_resolved = 1
        WHERE device_id = ? AND farm_id = ? AND parameter IS NULL AND title = ? AND is_resolved = 0`,
      [device.device_id, farmId, OFFLINE_TITLE]
    );
    await conn.query(
      'UPDATE early_warning_notifications SET device_id = NULL WHERE device_id = ? AND farm_id = ?',
      [device.device_id, farmId]
    );

    return {
      device_id: device.device_id,
      device_name: device.device_name,
      previous_pond_id: device.pond_id ?? null,
      previous_pond_name: previousPondName,
    };
  });
}

async function unregisterDevice({ deviceId, farmId, accountId }) {
  const out = await withRetry(() => tryUnregister({ deviceId, farmId }));
  await logDeviceEvent(
    accountId,
    'device_unregistered',
    `Removed device #${out.device_id} (${out.device_name}) from farm #${farmId}${out.previous_pond_name ? ` (it was on pond "${out.previous_pond_name}")` : ''}.`
  );
  return out;
}

// The reply the app gets after a move: what happened, plus the status of the
// pond that was left and of the pond that was entered, so the screen can
// update at once.
async function describeMove(farmId, move) {
  const [pond, previousPond] = await Promise.all([
    pondSnapshot(farmId, move.pond_id),
    move.previous_pond_id && move.previous_pond_id !== move.pond_id ? pondSnapshot(farmId, move.previous_pond_id) : null,
  ]);
  return { ...move, pond, previous_pond: previousPond };
}

module.exports = { assignDevice, registerDevice, unregisterDevice, describeMove, AssignmentError };
