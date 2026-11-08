#!/bin/sh
# Z kazety udělá snapshot a surové obrazy RAM. Potřebuje sources/tape/*.tzx
# (do gitu nepatří, viz sources/tape/README.md) a vendorovaný SkoolKit v tools/vendor.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SK="$ROOT/tools/vendor"
TZX="$ROOT/sources/tape/Underwurlde (1984)(Ultimate).tzx"
mkdir -p "$ROOT/build"
[ -f "$TZX" ] || { echo "chybi $TZX – viz sources/tape/README.md"; exit 1; }
PYTHONPATH="$SK" python3 "$SK/skoolkit-10.1.data/scripts/tap2sna.py" \
    --sim-load-config accelerator=speedlock \
    "$TZX" "$ROOT/build/underwurlde.z80"
PYTHONPATH="$SK" python3 - "$ROOT" <<'PY'
import sys
from skoolkit.snapshot import Snapshot
root = sys.argv[1]
ram = bytes(Snapshot.get(root + '/build/underwurlde.z80').ram(-1))
open(root + '/build/underwurlde.bin', 'wb').write(ram)
scr = open(root + '/sources/media/screens/loading_screen.scr', 'rb').read()
print('RAM $4000-$FFFF: %d B; loading screen souhlasi s .scr: %s'
      % (len(ram), ram[:6912] == scr))
PY
# Kazetový obraz je proti běžící hře posunutý o jeden bajt (hra si po nahrání
# celý blok přesune dolů), takže se hned vyrobí i runtime obraz – ten je jediný
# správný pro disassembly a pro extrakci dat. Viz sources/docs/disasm_notes.md §9.
PYTHONPATH="$SK" python3 "$ROOT/tools/mkruntime.py"

