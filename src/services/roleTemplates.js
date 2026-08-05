import { getExecutor } from '../db/adapter.js';
import { serializePermissions, parsePermissions } from '../lib/permissions.js';
import { RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// Saved role templates: a named permission preset (e.g. "מנהל חשבונות") the owner builds once
// and applies to a user in one click, instead of re-ticking the permission checklist each time.
// Applying a template is a client-side convenience (it fills the user form's checkboxes); the
// stored user permissions remain the source of truth, so deleting a template never affects users.

/** All templates, permissions parsed to a clean key array. */
export async function listRoleTemplates(x = getExecutor()) {
  const rows = await x.many('SELECT id, name, permissions FROM role_templates ORDER BY name', []);
  return rows.map((r) => ({ ...r, permissions: parsePermissions(r.permissions) }));
}

export async function createRoleTemplate({ name, permissions }, actor, x = getExecutor()) {
  const nm = (name || '').trim();
  if (!nm) throw new RuleError('VALIDATION', 'יש להזין שם לתבנית התפקיד.');
  // Portable uniqueness check (the unique index is a DB-level backstop).
  if (await x.one('SELECT id FROM role_templates WHERE name = ?', [nm])) {
    throw new RuleError('VALIDATION', 'כבר קיימת תבנית בשם הזה.');
  }
  const perms = serializePermissions(permissions);
  const r = await x.run('INSERT INTO role_templates (name, permissions) VALUES (?, ?)', [nm, perms]);
  await logAction(
    { userId: actor?.id ?? null, action: 'role_template.create', entityType: 'role_template', entityId: r.lastInsertRowid, details: { name: nm } },
    x,
  );
  return r.lastInsertRowid;
}

export async function updateRoleTemplate(id, { name, permissions }, actor, x = getExecutor()) {
  const nm = (name || '').trim();
  if (!nm) throw new RuleError('VALIDATION', 'יש להזין שם לתבנית התפקיד.');
  if (await x.one('SELECT id FROM role_templates WHERE name = ? AND id <> ?', [nm, id])) {
    throw new RuleError('VALIDATION', 'כבר קיימת תבנית בשם הזה.');
  }
  const perms = serializePermissions(permissions);
  await x.run('UPDATE role_templates SET name = ?, permissions = ? WHERE id = ?', [nm, perms, id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'role_template.update', entityType: 'role_template', entityId: id, details: { name: nm } },
    x,
  );
}

export async function deleteRoleTemplate(id, actor, x = getExecutor()) {
  await x.run('DELETE FROM role_templates WHERE id = ?', [id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'role_template.delete', entityType: 'role_template', entityId: id, details: {} },
    x,
  );
}
