import re
page=open('page.html').read().replace('/*LEAFLET_CSS*/', open('vendor/leaflet.css').read().replace('url(images/','url(data:,'))
open('artifact.html','w').write(page)
open('index.html','w').write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'+page+'</body></html>')
