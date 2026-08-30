#!/usr/bin/env bash
# Regenerates tests/fixtures/sample-event-sheet.xlsx.
# Hand-rolled OOXML so the fixture is reproducible and reviewable without an xlsx writer
# dependency. The sheet deliberately contains a junk title row, a blank row, and blank
# event-name cells so header detection and forward-fill are exercised by real input.
# Each row is one logical field carrying both channel names: payload (debug log) and
# attribute (network call), each with its own datatype.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

mkdir -p "$build/_rels" "$build/xl/_rels" "$build/xl/worksheets"

cat > "$build/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>
EOF

cat > "$build/_rels/.rels" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>
EOF

cat > "$build/xl/workbook.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Events" sheetId="1" r:id="rId1"/></sheets></workbook>
EOF

cat > "$build/xl/_rels/workbook.xml.rels" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>
EOF

cat > "$build/xl/worksheets/sheet1.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Acme Event Tracking Spec v3</t></is></c></row>
<row r="2"/>
<row r="3"><c r="A3" t="inlineStr"><is><t>Event Name</t></is></c><c r="B3" t="inlineStr"><is><t>Payload</t></is></c><c r="C3" t="inlineStr"><is><t>Payload Data Type</t></is></c><c r="D3" t="inlineStr"><is><t>Attribute</t></is></c><c r="E3" t="inlineStr"><is><t>Attribute Data Type</t></is></c><c r="F3" t="inlineStr"><is><t>Mandatory</t></is></c><c r="G3" t="inlineStr"><is><t>Description</t></is></c><c r="H3" t="inlineStr"><is><t>Example Value</t></is></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>add_to_cart</t></is></c><c r="B4" t="inlineStr"><is><t>product_id</t></is></c><c r="C4" t="inlineStr"><is><t>String</t></is></c><c r="D4" t="inlineStr"><is><t>prid</t></is></c><c r="E4" t="inlineStr"><is><t>String</t></is></c><c r="F4" t="inlineStr"><is><t>Yes</t></is></c><c r="G4" t="inlineStr"><is><t>Product SKU</t></is></c><c r="H4" t="inlineStr"><is><t>SKU123</t></is></c></row>
<row r="5"><c r="B5" t="inlineStr"><is><t>price</t></is></c><c r="C5" t="inlineStr"><is><t>Number</t></is></c><c r="D5" t="inlineStr"><is><t>pr</t></is></c><c r="E5" t="inlineStr"><is><t>Number</t></is></c><c r="F5" t="inlineStr"><is><t>Yes</t></is></c><c r="G5" t="inlineStr"><is><t>Unit price</t></is></c><c r="H5" t="inlineStr"><is><t>499.00</t></is></c></row>
<row r="6"><c r="B6" t="inlineStr"><is><t>currency</t></is></c><c r="C6" t="inlineStr"><is><t>String</t></is></c><c r="D6" t="inlineStr"><is><t>cur</t></is></c><c r="E6" t="inlineStr"><is><t>String</t></is></c><c r="F6" t="inlineStr"><is><t>No</t></is></c><c r="G6" t="inlineStr"><is><t>ISO 4217 code</t></is></c><c r="H6" t="inlineStr"><is><t>INR</t></is></c></row>
<row r="7"><c r="A7" t="inlineStr"><is><t>purchase</t></is></c><c r="B7" t="inlineStr"><is><t>order_id</t></is></c><c r="C7" t="inlineStr"><is><t>String</t></is></c><c r="D7" t="inlineStr"><is><t>oid</t></is></c><c r="E7" t="inlineStr"><is><t>String</t></is></c><c r="F7" t="inlineStr"><is><t>Mandatory</t></is></c><c r="G7" t="inlineStr"><is><t>Order reference</t></is></c><c r="H7" t="inlineStr"><is><t>ORD-1</t></is></c></row>
<row r="8"><c r="B8" t="inlineStr"><is><t>items</t></is></c><c r="C8" t="inlineStr"><is><t>Array</t></is></c><c r="D8" t="inlineStr"><is><t>itm</t></is></c><c r="E8" t="inlineStr"><is><t>Array</t></is></c><c r="F8" t="inlineStr"><is><t>Yes</t></is></c><c r="G8" t="inlineStr"><is><t>Line items</t></is></c><c r="H8" t="inlineStr"><is><t>[{"sku":"A"}]</t></is></c></row>
</sheetData></worksheet>
EOF

( cd "$build" && zip -q -r -X "$here/sample-event-sheet.xlsx" '[Content_Types].xml' _rels xl )
echo "wrote $here/sample-event-sheet.xlsx"
