function emitSyncEvent(req, entity, action, id) {
  const io = req?.app?.get?.('io');
  if (!io) return;
  io.emit('sync_event', {
    entity,
    action,
    id: id == null ? null : String(id),
    actorId: String(req.userId || ''),
    at: new Date().toISOString(),
  });
}

module.exports = { emitSyncEvent };
