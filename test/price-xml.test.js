import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceXml, extractGzLinks } from '../src/lib/priceXml.js';

const XML = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <ChainId>7290027600007</ChainId>
  <Items Count="5">
    <Item>
      <ItemCode>7290000000015</ItemCode>
      <ItemType>1</ItemType>
      <ItemName>חלב תנובה 3% &quot;קרטון&quot;</ItemName>
      <ManufacturerName>תנובה &amp; בניו</ManufacturerName>
      <UnitQty>ליטר</UnitQty>
      <Quantity>1.00</Quantity>
      <QtyInPackage>12</QtyInPackage>
      <ItemPrice>6.90</ItemPrice>
      <bIsWeighted>0</bIsWeighted>
      <ItemStatus>1</ItemStatus>
    </Item>
    <Item>
      <ItemCode>123456</ItemCode>
      <ItemType>0</ItemType>
      <ItemName>מלפפון במשקל</ItemName>
      <ManufacturerName>לא ידוע</ManufacturerName>
      <ItemPrice>3.50</ItemPrice>
      <bIsWeighted>1</bIsWeighted>
    </Item>
    <Item>
      <ItemCode>4006381333931</ItemCode>
      <ItemType>1</ItemType>
      <ItemName>מרקר סטבילו</ItemName>
      <ManufacturerName>Stabilo</ManufacturerName>
      <ItemPrice>12,345.67</ItemPrice>
      <bIsWeighted>0</bIsWeighted>
    </Item>
    <Item>
      <ItemCode>7290111111111</ItemCode>
      <ItemType>1</ItemType>
      <ItemName></ItemName>
      <ItemPrice>1.00</ItemPrice>
    </Item>
    <Item>
      <ItemCode>ABC</ItemCode>
      <ItemType>1</ItemType>
      <ItemName>קוד לא מספרי</ItemName>
    </Item>
  </Items>
</root>`;

test('parsePriceXml keeps only universal, non-weighted, named items', () => {
  const items = parsePriceXml(XML);
  assert.equal(items.length, 2); // weighted, empty-name and non-numeric codes dropped

  const milk = items[0];
  assert.equal(milk.barcode, '7290000000015');
  assert.equal(milk.name, 'חלב תנובה 3% "קרטון"'); // entities unescaped
  assert.equal(milk.manufacturerName, 'תנובה & בניו');
  assert.equal(milk.unitQty, 'ליטר');
  assert.equal(milk.quantity, 1);
  assert.equal(milk.qtyInPackage, 12);
  assert.equal(milk.retailPrice, 690); // agorot

  const marker = items[1];
  assert.equal(marker.retailPrice, 1234567); // thousands comma stripped
  assert.equal(marker.quantity, null); // missing optional tags → null
});

test("Shufersal's ManufactureName spelling (no r) is accepted too", () => {
  const items = parsePriceXml(
    '<Items><Item><ItemCode>96385074</ItemCode><ItemType>1</ItemType>' +
      '<ItemName>חלב</ItemName><ManufactureName>תנובה</ManufactureName><bIsWeighted>0</bIsWeighted></Item></Items>',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].manufacturerName, 'תנובה');
});

test('junk manufacturer values become null', () => {
  const items = parsePriceXml(
    '<Items><Item><ItemCode>96385074</ItemCode><ItemType>1</ItemType>' +
      '<ItemName>מוצר</ItemName><ManufacturerName>לא ידוע</ManufacturerName></Item></Items>',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].manufacturerName, null);
});

test('parsePriceXml survives empty / malformed input', () => {
  assert.deepEqual(parsePriceXml(''), []);
  assert.deepEqual(parsePriceXml(null), []);
  assert.deepEqual(parsePriceXml('<Items><Item><ItemCode>729'), []);
});

test('extractGzLinks pulls .gz hrefs with their SAS query strings, deduped in order', () => {
  const html = `
    <a href="https://blob.example/PriceFull7290027600007-001-202608110600.gz?sv=2020&amp;sig=abc">קובץ</a>
    <a href="/some/page">not a file</a>
    <a href="https://blob.example/PromoFull7290027600007-001-202608110600.gz?sig=x">promo</a>
    <a href="https://blob.example/PriceFull7290027600007-001-202608110600.gz?sv=2020&amp;sig=abc">שוב</a>
  `;
  const links = extractGzLinks(html);
  assert.equal(links.length, 2);
  assert.equal(links[0], 'https://blob.example/PriceFull7290027600007-001-202608110600.gz?sv=2020&sig=abc');
  assert.match(links[1], /PromoFull/);
});
