// One rule for "which employee is this saved name?" — used by every form whose "שם" field is an
// employee picker (Z closing, Z report, cash payment). Saved expense/payment rows store the NAME,
// not the id, so the edit form has to find the employee again from text.
//
// Two ways that lookup used to fail, both showing a real employee as "(לא ברשימת העובדים)":
//  1. An employee without a last name (bulk import allows it) renders as "נופר " — trailing space —
//     while the server trims the posted name to "נופר", so the two never compared equal.
//  2. Rows typed as free text before the picker existed hold just a first name.
// The fallback in (2) only fires when exactly one active employee has that first name — an
// ambiguous name stays unmatched rather than being pinned on the wrong person.

/** "first last", trimmed — never a trailing space when the last name is empty. */
export function employeeFullName(emp) {
  if (!emp) return '';
  return `${emp.first_name || ''} ${emp.last_name || ''}`.replace(/\s+/g, ' ').trim();
}

/**
 * The full name (as `employeeFullName` builds it) of the employee a saved name refers to, or null.
 * @param {Array<{first_name,last_name}>} employees
 * @param {string} saved
 */
export function matchEmployeeName(employees, saved) {
  const want = String(saved ?? '').replace(/\s+/g, ' ').trim();
  if (!want) return null;
  const list = employees || [];
  for (const e of list) if (employeeFullName(e) === want) return employeeFullName(e);
  const byFirst = list.filter((e) => String(e.first_name || '').trim() === want);
  return byFirst.length === 1 ? employeeFullName(byFirst[0]) : null;
}
