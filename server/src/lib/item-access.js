// Who may see or change an item. Shared by the items and media routes.

export function canEdit(item, user) {
  return Boolean(user) && (item.user_id === user.id || user.role === 'admin');
}

// Can this viewer ({ user } or { device }) see the item at all?
export function canView(item, { user = null, device = null } = {}) {
  if (item.status === 'ready') return Boolean(user || device);
  return canEdit(item, user);
}
