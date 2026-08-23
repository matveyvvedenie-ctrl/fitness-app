#!/usr/bin/env bash
# Поднимает версию фронтенда в одном месте.
#
# Версия живёт в ДВУХ местах и они обязаны совпадать:
#   index.html — ?v= у app.js и style.css (от старого кода)
#   version.txt — то же значение (от старого index.html, см. проверку
#                 версии в самом index.html)
# Расходятся — страница начнёт перезагружать сама себя или наоборот
# перестанет обновляться. Поэтому меняем только этим скриптом.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 - <<'PY'
import io, re, datetime
h = io.open('index.html', encoding='utf-8').read()
cur = re.search(r'app\.js\?v=([0-9a-z]+)', h).group(1)
today = datetime.date.today().strftime('%Y%m%d')
new = today + 'a' if not cur.startswith(today) else today + chr(ord(cur[len(today):] or 'a') + 1)
h = re.sub(r'app\.js\?v=[0-9a-z]+', 'app.js?v=' + new, h)
h = re.sub(r'style\.css\?v=[0-9a-z]+', 'style.css?v=' + new, h)
# body.jpg — картинка-подсказка к замерам, версия у неё своя и меняется
# только когда меняют саму картинку. Её НЕ трогаем: гонять полмегабайта
# заново при каждой правке стилей незачем.
io.open('index.html', 'w', encoding='utf-8').write(h)
io.open('version.txt', 'w', encoding='utf-8').write(new + '\n')
print(cur, '->', new)
PY
