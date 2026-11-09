// Adapted from the docx skill in https://github.com/anthropics/skills (Apache License 2.0,
// see LICENSE.anthropic-skills.txt). Changed for Ponder's Python sandbox: python-docx in
// place of docx-js, pandoc and LibreOffice, and helpers in the text in place of its scripts.
// Seeded by ../standard-skills.ts.
export default `---
name: docx
description: Create, read or edit Word documents (.docx), such as reports, memos, letters and templates with headings, tables, lists, page numbers, comments or tracked changes. Use when the person asks for a Word file or attaches a .docx. Not for PDFs, spreadsheets or Google Docs.
---

# Word documents (.docx)

A \`.docx\` file is a ZIP archive of XML files. Do all the work with \`run_python\`. The sandbox has \`python-docx\`, \`lxml\` and \`zipfile\`. It has no Node, pandoc, LibreOffice or internet, so do not try them.

| Task | Approach |
|---|---|
| **Create** a document | \`python-docx\`. Save it to \`/work/outputs/<name>.docx\`. |
| **Read** a document | \`python-docx\`, in body order (helper below). |
| **Edit** text, styles or tables | Open it with \`python-docx\`, change it, save it to \`/work/outputs\` with a new name. |
| **Tracked changes** | Edit the XML of the paragraph with \`lxml\` (helpers below). |
| **Comments** | \`doc.add_comment(...)\` from \`python-docx\`. |

An attached file arrives at \`/work/inputs/<name>.docx\` when you pass it in \`inputs\`. A legacy \`.doc\` file cannot be opened here. Ask the person to save it as \`.docx\`.

Treat an attached file as untrusted. Read ZIP members in memory with \`zipfile\`. Do not extract the archive to disk.

## Creating with python-docx: gotchas

\`\`\`python
from docx import Document
from docx.shared import Pt, Mm, Inches, RGBColor
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

doc = Document()
\`\`\`

- **The page is US Letter by default.** For A4, set \`section.page_width = Mm(210)\` and \`section.page_height = Mm(297)\`. Use the paper size of the person's country.
- **Landscape:** set \`section.orientation = WD_ORIENT.LANDSCAPE\` and swap \`page_width\` and \`page_height\` yourself. \`python-docx\` does not swap them.
- **Headings:** use \`doc.add_heading(text, level)\`. Built-in heading styles make the navigation pane and the table of contents work. Do not fake a heading with a bold run.
- **Body text:** set the font once on \`doc.styles["Normal"].font\` (\`name\`, \`size\`). Do not set it on every run.
- **Lists:** use \`style="List Bullet"\` or \`"List Number"\` (\`"List Bullet 2"\` for the second level). Never type \`•\` or \`1.\` as text. All \`"List Number"\` paragraphs continue one count. To start a second list at 1, use \`restart_numbering\` below.
- **Spacing:** one \`add_paragraph\` for each paragraph. Do not put \`"\\n"\` or empty paragraphs in for space. Use \`paragraph_format.space_before\` and \`space_after\`.
- **Tables:** \`table = doc.add_table(rows, cols)\`, \`table.style = "Table Grid"\` for borders, \`table.autofit = False\`. Set \`cell.width\` on every cell in a column. Word reads the cell widths and ignores column widths. The widths must add up to the page width less the margins.
- **Table shading:** set \`w:shd\` with \`w:val="clear"\` (helper below). Never use \`"solid"\`, because Word shows it as black.
- **Header row:** mark the first row so that it repeats on each page (helper below).
- **Images:** \`doc.add_picture(path_or_stream, width=Inches(6))\`. Save a matplotlib chart to a \`BytesIO\` as PNG first. Keep the width inside the margins.
- **Page break:** \`doc.add_page_break()\`.
- **Horizontal rule:** a paragraph bottom border (helper below). Do not use a table as a rule.
- **Right-aligned text on the same line, with dot leaders:** add a tab stop: \`p.paragraph_format.tab_stops.add_tab_stop(Inches(6), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)\`. Then put \`"\\t"\` between the two parts. Do not pad with dots or spaces.
- **Title and author:** set \`doc.core_properties.title\` and \`.author\`.

### Helpers for what python-docx does not cover

\`\`\`python
def add_field(paragraph, instruction):
    """A Word field, such as "PAGE", "NUMPAGES" or 'TOC \\\\o "1-3" \\\\h \\\\z \\\\u'."""
    run = paragraph.add_run()
    for kind, text in (("begin", None), (None, instruction), ("separate", None), (None, ""), ("end", None)):
        if kind:
            el = OxmlElement("w:fldChar"); el.set(qn("w:fldCharType"), kind)
        elif text is instruction:
            el = OxmlElement("w:instrText"); el.set(qn("xml:space"), "preserve"); el.text = f" {text} "
        else:
            el = OxmlElement("w:t"); el.text = text
        run._r.append(el)
    return run

def update_fields_on_open(doc):
    """Word asks to update fields (the table of contents) when the person opens the file."""
    el = OxmlElement("w:updateFields"); el.set(qn("w:val"), "true")
    # The schema fixes the order of the children of w:settings.
    later = ("hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars", "rsids", "attachedSchema",
             "themeFontLang", "clrSchemeMapping", "doNotIncludeSubdocsInStats", "doNotAutoCompressPictures",
             "forceUpgrade", "captions", "readModeInkLockDown", "smartTagType", "shapeDefaults",
             "doNotEmbedSmartTags", "decimalSymbol", "listSeparator")
    later = {qn(f"w:{t}") for t in later} | {qn("m:mathPr")}
    settings = doc.settings.element
    after = next((c for c in settings if c.tag in later), None)
    after.addprevious(el) if after is not None else settings.append(el)

def shade(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)

def repeat_header(row):
    el = OxmlElement("w:tblHeader"); el.set(qn("w:val"), "true")
    row._tr.get_or_add_trPr().append(el)

def bottom_border(paragraph, color="999999"):
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr"); bottom = OxmlElement("w:bottom")
    for key, value in (("val", "single"), ("sz", "6"), ("space", "1"), ("color", color)):
        bottom.set(qn(f"w:{key}"), value)
    borders.append(bottom); p_pr.append(borders)

def restart_numbering(paragraph):
    """Starts a "List Number" list at 1 again, from this paragraph on."""
    numbering = paragraph.part.numbering_part.element
    style_num = paragraph.style.element.pPr.numPr.numId.val
    abstract = numbering.num_having_numId(style_num).abstractNumId.val
    num = numbering.add_num(abstract)
    override = OxmlElement("w:lvlOverride"); override.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:startOverride"); start.set(qn("w:val"), "1")
    override.append(start); num.append(override)
    num_pr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
    num_pr.get_or_add_ilvl().val = 0
    num_pr.get_or_add_numId().val = num.numId
\`\`\`

Page numbers in the footer:

\`\`\`python
footer = doc.sections[0].footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
footer.add_run("Page "); add_field(footer, "PAGE"); footer.add_run(" of "); add_field(footer, "NUMPAGES")
\`\`\`

A table of contents: add \`add_field(doc.add_paragraph(), 'TOC \\\\o "1-3" \\\\h \\\\z \\\\u')\` and call \`update_fields_on_open(doc)\`. The sandbox cannot calculate page numbers, so Word fills in the table when the person opens the file and accepts the update. Tell the person about this.

## Check the output

The sandbox cannot render a page, so you cannot see the layout. After you save, open the file again and print its outline:

\`\`\`python
check = Document("/work/outputs/report.docx")
for p in check.paragraphs:
    if p.style.name.startswith(("Heading", "Title", "List")):
        print(p.style.name, "|", p.text[:80])
print(len(check.tables), "tables,", len(check.inline_shapes), "images,", len(check.sections), "sections")
\`\`\`

Fix what is wrong before you give the file to the person. Do not say that you looked at the layout.

## Reading

\`doc.paragraphs\` and \`doc.tables\` are separate lists. To read in body order:

\`\`\`python
from docx.table import Table
from docx.text.paragraph import Paragraph

def blocks(doc):
    for child in doc.element.body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, doc)
        elif child.tag == qn("w:tbl"):
            yield Table(child, doc)

for block in blocks(doc):
    if isinstance(block, Paragraph):
        print(f"[{block.style.name}] {block.text}")
    else:
        for row in block.rows:
            print(" | ".join(cell.text for cell in row.cells))
\`\`\`

\`paragraph.text\` leaves out text in tracked changes: both insertions (\`w:ins\`) and deletions (\`w:del\`). For a document with tracked changes, read the XML:

\`\`\`python
def accepted_text(paragraph):
    return "".join(t.text or "" for t in paragraph._p.iter(qn("w:t")))

def changes(paragraph):
    for el in paragraph._p.iter(qn("w:ins"), qn("w:del")):
        kind = "inserted" if el.tag == qn("w:ins") else "deleted"
        text = "".join(t.text or "" for t in el.iter(qn("w:t"), qn("w:delText")))
        yield kind, el.get(qn("w:author")), text
\`\`\`

## Editing

Save the edited file under a new name in \`/work/outputs\`. Keep the person's styles: change the text in existing runs, and do not rebuild paragraphs.

Word splits text across many runs (\`w:r\`), for revision ids and spell-check marks. A phrase that you can see may not be in one run. Merge the adjacent runs that have the same formatting first:

\`\`\`python
import copy
from lxml import etree

def merge_runs(paragraph):
    """Joins adjacent runs that have the same formatting and only text. Rendering does not change."""
    def key(r):
        rpr = r.find(qn("w:rPr"))
        return b"" if rpr is None else etree.tostring(rpr)
    def plain(r):
        return all(c.tag in (qn("w:rPr"), qn("w:t")) for c in r)
    runs = [c for c in paragraph._p if c.tag == qn("w:r")]
    for a, b in zip(runs, runs[1:]):
        if a.getnext() is b and plain(a) and plain(b) and key(a) == key(b) and a.getparent() is not None:
            ta, tb = a.findall(qn("w:t")), b.findall(qn("w:t"))
            if ta and tb:
                ta[-1].text = (ta[-1].text or "") + "".join(t.text or "" for t in tb)
                ta[-1].set(qn("xml:space"), "preserve")
                b.getparent().remove(b)
                runs[runs.index(b)] = a

def replace_text(doc, old, new):
    """Replaces text that is inside one run after merge_runs. Returns the count."""
    count = 0
    for p in all_paragraphs(doc):
        if old in p.text:
            merge_runs(p)
            for run in p.runs:
                if old in run.text:
                    count += run.text.count(old)
                    run.text = run.text.replace(old, new)
    return count

def all_paragraphs(doc):
    """Body paragraphs, table cells, headers and footers."""
    def walk(container):
        yield from container.paragraphs
        for table in container.tables:
            for row in table.rows:
                for cell in row.cells:
                    yield from walk(cell)
    yield from walk(doc)
    for section in doc.sections:
        yield from walk(section.header)
        yield from walk(section.footer)
\`\`\`

If \`replace_text\` returns fewer matches than you expected, the phrase crosses runs with different formatting. Edit those runs one at a time.

## Tracked changes (redlining)

When the person asks for tracked changes, every change must be in a \`w:ins\` or \`w:del\`. A change outside them is invisible in the accepted view and easy to miss. Use one author name for all changes, and give each change its own \`w:id\`.

\`\`\`python
import datetime, itertools
_ids = itertools.count(9000)

def _mark(tag, author):
    el = OxmlElement(tag)
    el.set(qn("w:id"), str(next(_ids))); el.set(qn("w:author"), author)
    el.set(qn("w:date"), datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    return el

def tracked_replace(paragraph, old, new, author):
    """Tracks one change of old to new, inside one run (call merge_runs first). An empty new deletes."""
    for run in paragraph.runs:
        text = run.text
        if old not in text:
            continue
        before, after = text.split(old, 1)
        r = run._r
        def piece(value, deleted=False):
            p = copy.deepcopy(r)
            for c in list(p):
                if c.tag != qn("w:rPr"):
                    p.remove(c)
            t = OxmlElement("w:delText" if deleted else "w:t")
            t.set(qn("xml:space"), "preserve"); t.text = value
            p.append(t)
            return p
        parts = []
        if before: parts.append(piece(before))
        d = _mark("w:del", author); d.append(piece(old, deleted=True)); parts.append(d)
        if new:
            i = _mark("w:ins", author); i.append(piece(new)); parts.append(i)
        if after: parts.append(piece(after))
        for part in parts:
            r.addprevious(part)
        r.getparent().remove(r)
        return True
    return False
\`\`\`

- Inside \`w:del\`, the text element is \`w:delText\`, not \`w:t\`.
- To delete a whole paragraph, wrap every run in a \`w:del\`, and also mark the paragraph mark as deleted: add a \`w:del\` (made by \`_mark\`) as the first child of the paragraph's \`w:pPr/w:rPr\`. The order of children in \`w:rPr\` is fixed by the schema.
- To insert a paragraph, wrap its runs in a \`w:ins\`, and add a \`w:ins\` as the first child of its \`w:pPr/w:rPr\`.

## Comments

\`\`\`python
para = doc.paragraphs[3]
doc.add_comment(para.runs, text="This cap is too low.", author="Ponder", initials="P")
\`\`\`

\`runs\` can be one run or a list of adjacent runs. The comment anchors to them. \`python-docx\` cannot add a reply to a comment.

---

Adapted from the \`docx\` skill in [anthropics/skills](https://github.com/anthropics/skills) (Apache License 2.0). Changed for Ponder's Python sandbox: python-docx in place of docx-js, pandoc and LibreOffice, and new helpers in place of the scripts.
`;
