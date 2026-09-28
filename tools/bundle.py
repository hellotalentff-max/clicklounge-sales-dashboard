"""Builds dist/: one Code.gs + one Index.html + appsscript.json, for easy copy-paste into Apps Script."""
import os, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src, dist = os.path.join(root, 'src'), os.path.join(root, 'dist')
os.makedirs(dist, exist_ok=True)
order = ['Code', 'Utils', 'Database', 'Config', 'Audit', 'Users', 'Commission', 'Schedules',
         'Sales', 'Packages', 'Reports', 'Setup', 'Tests']
read = lambda f: open(os.path.join(src, f), encoding='utf-8').read()
gs = '\n\n'.join('// ===== ' + n + '.gs =====\n' + read(n + '.gs') for n in order)
open(os.path.join(dist, 'Code.gs'), 'w', encoding='utf-8').write(
    '// ClickLounge Sales Dashboard — bundled from src/ by tools/bundle.py. Edit src/, not this file.\n\n' + gs)
html = read('Index.html')
html = re.sub(r"<\?!=\s*include_\('CSS'\);?\s*\?>", lambda m: read('CSS.html'), html)
html = re.sub(r"<\?!=\s*include_\('JS'\);?\s*\?>", lambda m: read('JS.html'), html)
assert '<?' not in html, 'template tag left in bundle'
open(os.path.join(dist, 'Index.html'), 'w', encoding='utf-8').write(html)
open(os.path.join(dist, 'appsscript.json'), 'w', encoding='utf-8').write(read('appsscript.json'))
print('dist/ built:', ', '.join(sorted(os.listdir(dist))))
