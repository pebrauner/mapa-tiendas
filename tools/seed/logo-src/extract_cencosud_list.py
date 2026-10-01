"""Extract the 'Perú | Supermercados' store list (Metro / Wong) from the text dump of
Cencosud's Memoria Integrada 2025 (pdftotext -layout) into a small CSV for later verification.
Addresses are as printed; a few wrap onto a second line in the PDF and are kept truncated."""
import csv, re, sys

src, out = sys.argv[1], sys.argv[2]
SRC = "https://www.cencosud.com/cencosud/site/docs/20260410/20260410085306/memoria_integrada_2025_cencosud.pdf"  # store list as of 2025-12-31
# (the PDF's owned/leased and m2 columns are misaligned in the text dump, so they are not exported)
lines = open(src, encoding="utf-8").read().splitlines()
start = next(i for i, l in enumerate(lines) if l.strip().startswith("Perú | Supermercados") and "...." not in l)
rows = []
for l in lines[start:start + 140]:
    if l.strip().startswith("Subsidiarias y asociadas"):
        break
    m = re.match(r"^\s{0,4}((Metro|Wong)\s.*?)\s{2,}(.*?)\s*$", l)
    if not m:
        continue
    name, rest = m.group(1).strip(), m.group(3)
    tenure = ""
    t = re.search(r"\s(Propio|Arrendado)\b", rest)
    if t:
        tenure = t.group(1)
        rest = rest[:t.start()]
    addr = re.sub(r"\s{2,}.*$", "", rest).strip()
    rows.append({"chain": name.split()[0].lower(), "name": name, "address_as_printed": addr, "source": SRC})
with open(out, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=["chain", "name", "address_as_printed", "source"])
    w.writeheader()
    w.writerows(rows)
print(len(rows), "rows;", sum(r["chain"] == "metro" for r in rows), "metro,", sum(r["chain"] == "wong" for r in rows), "wong")
