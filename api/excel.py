"""Un libro de Excel (.xlsx) con lo mínimo, sin dependencias.

    libro([("Hoja", [fila, fila, …]), …]) -> bytes

Un .xlsx es un zip de XML y `zipfile` viene con Python: para tablas planas no hace falta
openpyxl (PLAN-STACK.md §2: una dependencia nueva se justifica, y ésta no). Cada fila es
una lista de celdas; un número (int, float, Decimal) sale como número, para que en Excel
se pueda sumar y ordenar, y todo lo demás como texto. La primera fila de cada hoja va en
negritas y queda fija al hacer scroll.

Lo que NO hace: fórmulas, fechas como fecha (van como texto), colores ni celdas unidas.
Un texto que empiece con `=`, `+`, `-` o `@` se escribe como texto y no como fórmula:
los títulos vienen de portales, o sea de terceros.
"""
from __future__ import annotations

import io
import re
import zipfile
from decimal import Decimal
from xml.sax.saxutils import escape

# XML 1.0 no admite la mayoría de los caracteres de control: Excel rechaza el archivo.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_HOJA_MALA = re.compile(r"[\[\]:*?/\\]")


def _col(n: int) -> str:
    """0 → A, 25 → Z, 26 → AA."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _celda(ref: str, v, negrita: bool) -> str:
    estilo = ' s="1"' if negrita else ""
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        v = "Sí" if v else "No"
    if isinstance(v, (int, float, Decimal)):
        return f'<c r="{ref}"{estilo}><v>{v}</v></c>'
    texto = escape(_CONTROL.sub("", str(v)))
    return f'<c r="{ref}"{estilo} t="inlineStr"><is><t xml:space="preserve">{texto}</t></is></c>'


def _hoja(filas: list[list]) -> str:
    anchos: dict[int, int] = {}
    cuerpo = []
    for i, fila in enumerate(filas):
        celdas = []
        for j, v in enumerate(fila):
            celdas.append(_celda(f"{_col(j)}{i + 1}", v, negrita=i == 0))
            largo = max((len(x) for x in str(v if v is not None else "").split("\n")), default=0)
            anchos[j] = max(anchos.get(j, 0), min(largo, 60))
        cuerpo.append(f'<row r="{i + 1}">{"".join(celdas)}</row>')
    cols = "".join(f'<col min="{j + 1}" max="{j + 1}" width="{max(8, a + 2)}" customWidth="1"/>'
                   for j, a in sorted(anchos.items()))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" '
            'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            f'{"<cols>" + cols + "</cols>" if cols else ""}'
            f'<sheetData>{"".join(cuerpo)}</sheetData></worksheet>')


def libro(hojas: list[tuple[str, list[list]]]) -> bytes:
    nombres = [_HOJA_MALA.sub(" ", n)[:31] or f"Hoja{i + 1}" for i, (n, _) in enumerate(hojas)]
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pkg = "http://schemas.openxmlformats.org/package/2006"
    tipo = "application/vnd.openxmlformats-officedocument.spreadsheetml"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="{pkg}/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   f'<Override PartName="/xl/workbook.xml" ContentType="{tipo}.sheet.main+xml"/>'
                   f'<Override PartName="/xl/styles.xml" ContentType="{tipo}.styles+xml"/>'
                   + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="{tipo}.worksheet+xml"/>'
                             for i in range(len(hojas))) + "</Types>")
        z.writestr("_rels/.rels",
                   f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{pkg}/relationships">'
                   f'<Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",
                   f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>'
                   + "".join(f'<sheet name="{escape(n, {chr(34): "&quot;"})}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
                             for i, n in enumerate(nombres)) + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{pkg}/relationships">'
                   + "".join(f'<Relationship Id="rId{i + 1}" Type="{rel}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
                             for i in range(len(hojas)))
                   + f'<Relationship Id="rId{len(hojas) + 1}" Type="{rel}/styles" Target="styles.xml"/></Relationships>')
        # Dos estilos: el normal y el de encabezado (negritas).
        z.writestr("xl/styles.xml",
                   f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{ns}">'
                   '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
                   '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
                   '<fills count="2"><fill><patternFill patternType="none"/></fill>'
                   '<fill><patternFill patternType="gray125"/></fill></fills>'
                   '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                   '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                   '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                   '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
                   '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                   '</styleSheet>')
        for i, (_, filas) in enumerate(hojas):
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", _hoja(filas))
    return buf.getvalue()


def selfcheck() -> None:
    from xml.dom import minidom
    datos = libro([("Cliente: ALSEA/1", [["Campo", "Valor"], ["Nombre", "ALSEA & Cía <1>"], ["Precio", Decimal("1500000.50")]]),
                   ("Propiedades", [["#", "Título"], [1, "=SUMA(A1)"], [2, "con\x07campana\ny salto"], [3, None]])])
    with zipfile.ZipFile(io.BytesIO(datos)) as z:
        assert z.testzip() is None
        for nombre in z.namelist():
            minidom.parseString(z.read(nombre))            # todo es XML bien formado
        libro_xml, h1, h2 = (z.read(n).decode() for n in ("xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"))
    assert 'name="Cliente  ALSEA 1"' in libro_xml, "un nombre de hoja no lleva : ni /"
    assert "ALSEA &amp; Cía &lt;1&gt;" in h1 and "<v>1500000.50</v>" in h1
    assert 't="inlineStr"><is><t xml:space="preserve">=SUMA(A1)</t>' in h2, "una fórmula ajena se queda en texto"
    assert "\x07" not in h2 and 'r="A2"><v>1</v>' in h2 and 'r="B4"' not in h2
    assert _col(0) == "A" and _col(25) == "Z" and _col(26) == "AA" and _col(701) == "ZZ"
