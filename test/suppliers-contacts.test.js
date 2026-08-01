import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import {
  createSupplier,
  updateSupplierContacts,
  searchSuppliers,
  getSupplier,
} from '../src/services/suppliers.js';

test('createSupplier stores contact details', () => {
  const db = freshDb();
  const o = owner(db);
  const s = createSupplier(
    { name: 'ספק בדיקה', taxId: '514000000', phone: '03-1234567', email: 'a@b.com', contactName: 'רונית', contactPhone: '050-1111111' },
    o,
    db,
  );
  assert.equal(s.phone, '03-1234567');
  assert.equal(s.email, 'a@b.com');
  assert.equal(s.contact_name, 'רונית');
  assert.equal(s.contact_phone, '050-1111111');
});

test('updateSupplierContacts edits contact fields; blanks become null', () => {
  const db = freshDb();
  const o = owner(db);
  const s = createSupplier({ name: 'ספק 2', phone: '000' }, o, db);
  updateSupplierContacts(s.id, { phone: '', email: 'new@x.com', contactName: 'משה', contactPhone: '' }, o, db);
  const after = getSupplier(s.id, db);
  assert.equal(after.phone, null);
  assert.equal(after.email, 'new@x.com');
  assert.equal(after.contact_name, 'משה');
  assert.equal(after.contact_phone, null);
});

test('searchSuppliers matches name / tax id / phone / contact', () => {
  const db = freshDb();
  const o = owner(db);
  createSupplier({ name: 'אלפא ספקים', taxId: '111', phone: '02-9999999', contactName: 'דנה' }, o, db);
  createSupplier({ name: 'בטא בע"מ', taxId: '222', phone: '03-8888888', contactName: 'יוסי' }, o, db);
  assert.equal(searchSuppliers('אלפא', db).length, 1);
  assert.equal(searchSuppliers('222', db).length, 1);
  assert.equal(searchSuppliers('9999999', db).length, 1);
  assert.equal(searchSuppliers('יוסי', db).length, 1);
  assert.equal(searchSuppliers('', db).length, 0); // empty query -> no results
  assert.ok(searchSuppliers('בע"מ', db).length >= 1);
});
