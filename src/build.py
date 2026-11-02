import sys
TOKEN="pk.eyJ1IjoiZ2VyaXZhZ3lvayIsImEiOiJjbXZ6aGQ0OW8xanJwMnhzOW83YWs3a2VpIn0.PNP7EFmgBNIz1eceFpotkw"
src=open('src.html').read()
teams=open('teams.js').read(); cities=open('cities.js').read()
import os
if os.path.exists('/home/claude/deps'):
    css=open('/home/claude/deps/x/maplibre-gl-4.7.1/package/dist/maplibre-gl.css').read()
    topo=open('/home/claude/deps/x/world-atlas-2.0.2/package/countries-50m.json').read()
    # artifact
    a=src.replace('/*__MLCSS__*/',css).replace('/*__TOPO__*/',topo).replace('/*__TEAMS__*/',teams).replace('/*__CITIES__*/',cities)
    open('fap.html','w').write(a)
    t=a.replace('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js','ml.js').replace('https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js','tj.js')
    open('test.html','w').write('<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'+t+'</body></html>')

# mapbox standalone
s=src
s=s.replace('<style>/*__MLCSS__*/</style>','<link rel="stylesheet" href="https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.css">')
s=s.replace('<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>\n<script src="https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js"></script>\n<script>const WORLD=/*__TOPO__*/;</script>','<script src="https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js"></script>')
i=s.index('const land=topojson.feature');j=s.index('/* two clustered sources')
s=s[:i]+'''mapboxgl.accessToken="%s";
const __t=(()=>{try{const v=localStorage.getItem("fap.theme");if(v==="light"||v==="dark")return v;}catch(_){}return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";})();
let curStyle=__t==="dark"?"mapbox://styles/mapbox/dark-v11":"mapbox://styles/mapbox/light-v11";
const map=new mapboxgl.Map({container:"map",style:curStyle,language:"hu",center:[12,40],zoom:2.1,minZoom:1,maxZoom:19,customAttribution:"FAP"});
map.addControl(new mapboxgl.NavigationControl({showCompass:false}),"bottom-right");
map.addControl(new mapboxgl.GeolocateControl({positionOptions:{enableHighAccuracy:false},showUserLocation:false}),"bottom-right");
map.dragRotate.disable();map.touchZoomRotate.disableRotation();
map.on("style.load",()=>{const dk=/dark/.test(curStyle);try{map.setFog(dk?{color:"#16181c","high-color":"#0e1013","space-color":"#0b0c0e","horizon-blend":.06,"star-intensity":0}:{color:"#f4f5f7","high-color":"#dfe3ea","space-color":"#eef0f3","horizon-blend":.08,"star-intensity":0});}catch(_){}if(typeof setupLayers==="function")setupLayers();});

'''%TOKEN+s[j:]
s=s.replace('applyTheme(theme,false);','onThemeMap=()=>{const want=P().style;if(want!==curStyle){curStyle=want;ready=false;clearLabels();map.setStyle(want,{diff:false});}else if(ready)applyMapTheme();};\napplyTheme(theme,false);')
s=s.replace('maplibregl','mapboxgl')
s=s.replace('try{const z=await map.getSource(src).getClusterExpansionZoom(id);map.easeTo({center,zoom:Math.min(z+0.2,18)});}catch(_){}','map.getSource(src).getClusterExpansionZoom(id,(err,z)=>{if(err||z==null)return;map.easeTo({center,zoom:Math.min(z+0.2,19)});});')
s=s.replace('let db=null, uid=null, myPin=null;','let db=null, uid=null, myPin=null;\nconst LS="fap.mypin";\ntry{const v=JSON.parse(localStorage.getItem(LS)||"null");if(v&&typeof v.t==="string")localOnly={...v,demo:false};}catch(_){}')
s=s.replace('else {localOnly={...pin,demo:false};myPin=localOnly;','else {localOnly={...pin,demo:false};myPin=localOnly;try{localStorage.setItem(LS,JSON.stringify(pin));}catch(_){}')
s=s.replace('localOnly=null;myPin=null;showMine(null);','localOnly=null;myPin=null;try{localStorage.removeItem(LS);}catch(_){}showMine(null);')
s=s.replace('if(!use){$("#modeNote").textContent="Előnézet";return;}','if(!use){$("#modeNote").textContent="";if(localOnly){myPin=localOnly;map.once("load",()=>showMine(localOnly));}return;}')
s=s.replace('<meta name="claude:viewport-fit-sides" content="cover">\n','<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n')
s=s.replace('</style>\n\n<div id="map"','</style>\n</head>\n<body>\n<div id="map"',1)
s='<!doctype html>\n<html lang="hu">\n<head>\n'+s+'\n</body>\n</html>\n'
s=s.replace('/*__TEAMS__*/',teams).replace('/*__CITIES__*/',cities)
assert 'maplibre' not in s and 'topojson' not in s
open('../index.html','w').write(s)
for f in []:
    x=open(f).read();k=x.rfind('<script>');open('/tmp/claude-0/t/'+f+'.js','w').write(x[k+8:x.rfind('</script>')])
