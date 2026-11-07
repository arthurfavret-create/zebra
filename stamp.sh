#!/bin/sh
# Ajoute un numéro de version aux scripts pour que le navigateur recharge toujours la dernière version
V=$(date +%Y%m%d%H%M)
sed -i -E "s/(src=\"(engine|label|app|draw)\.js)(\?v=[0-9]+)?\"/\1?v=$V\"/g" index.html
sed -i -E "s/const APP_VERSION = '[0-9]*';/const APP_VERSION = '$V';/" app.js
echo "$V"
