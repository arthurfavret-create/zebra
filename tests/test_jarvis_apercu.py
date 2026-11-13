"""Aperçu des tickets + lien « Gestion des tickets » : vrai jarvis-print (sans imprimante) + Zebra Studio dans Chromium.
  docker run --rm --network host -v ~/projets:/p:ro -e HOME=/tmp mcr.microsoft.com/playwright/python:v1.49.0-noble sh -c \
   'pip install -q --target /deps -r /p/jarvis-print/requirements.txt && python /p/zebra/tests/test_jarvis_apercu.py'
"""
import base64, os, struct, subprocess, sys, tempfile, threading, time, urllib.request, json
sys.path.insert(0, "/deps"); sys.path.insert(0, "/p/jarvis-print")
DONNEES = tempfile.mkdtemp()
os.environ.update(CORS_ORIGINE="http://127.0.0.1:18080", DONNEES=DONNEES, IMPRIMANTE_CHEMIN=DONNEES + "/absente")
import uvicorn
from app import main
threading.Thread(target=uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=18090, log_level="warning")).run, daemon=True).start()
subprocess.Popen([sys.executable, "-m", "http.server", "18080", "-d", "/p/zebra"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
J = "http://127.0.0.1:18090"
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 820, "height": 1100}); p = ctx.new_page()
    erreurs = []; p.on("pageerror", lambda e: erreurs.append(str(e)))
    p.add_init_script(f"localStorage.setItem('zebra-jarvis','{J}'); localStorage.setItem('zebra-dest','jarvis');")
    p.goto("http://127.0.0.1:18080/index.html"); p.wait_for_timeout(800)
    p.click("#btnSettings"); p.wait_for_timeout(300)
    # lien de gestion construit sur l'adresse réglée
    assert p.get_attribute("#btnGestion", "href") == J + "/", p.get_attribute("#btnGestion", "href")
    p.fill("#jarvisUrl", "https://jarvis.exemple.ts.net:8443"); p.dispatch_event("#jarvisUrl", "change"); p.wait_for_timeout(200)
    assert p.get_attribute("#btnGestion", "href") == "https://jarvis.exemple.ts.net:8443/"
    p.fill("#jarvisUrl", J); p.dispatch_event("#jarvisUrl", "change"); p.wait_for_timeout(200)
    p.click("#sheetBg", position={"x": 5, "y": 5}); p.wait_for_timeout(300)
    # un ticket assez long (plusieurs morceaux ^XA…^XZ)
    p.evaluate("""() => { state.blocks = []; for (let i = 0; i < 40; i++) addBlock('text', { text: 'Ligne ' + i + ' du ticket de test' }); }""")
    pages_h = p.evaluate("(async () => { const pg = await compose(); return [pg.length, pg[0].width, pg[0].height, (buildZpl(pg).match(/\\^XA/g)||[]).length]; })()")
    print("pages, largeur, hauteur, morceaux ZPL :", pages_h)
    assert pages_h[1] == 384 and pages_h[3] >= 2, "il faut un ticket en plusieurs morceaux pour ce test"
    zpl_attendu = p.evaluate("(async () => buildZpl(await compose()))()")
    p.click("#btnPrint"); p.wait_for_timeout(4000); p.screenshot(path=os.environ.get("SORTIE", "/tmp") + "/avant-choix.png"); p.wait_for_selector("[data-choix='file']", timeout=15000); p.click("[data-choix='file']"); p.wait_for_timeout(2500)
    t = json.load(urllib.request.urlopen(J + "/api/tickets")); assert len(t) == 1 and t[0]["a_apercu"] == 1, t
    png = urllib.request.urlopen(f"{J}/api/tickets/{t[0]['id']}/apercu.png").read()
    largeur, hauteur = struct.unpack(">II", png[16:24])
    assert largeur == 384 and hauteur == pages_h[2], (largeur, hauteur, pages_h)  # TOUT le ticket, pas un morceau
    print("PNG", len(png), "octets", largeur, "x", hauteur)
    print("zpl…"); assert json.load(urllib.request.urlopen(f"{J}/api/tickets/{t[0]['id']}", timeout=10))["zpl"] == zpl_attendu, "le ZPL doit partir tel quel"; print("zpl ok")
    # liste de la file : miniature réduite puis taille réelle au toucher
    p.evaluate("void ouvrirFile(null)"); p.wait_for_selector("#aiSheet img[data-apercu]", timeout=8000)
    p.wait_for_function("document.querySelector('#aiSheet img[data-apercu]').naturalWidth === 384")
    w = lambda: p.evaluate("document.querySelector('#aiSheet img[data-apercu]').getBoundingClientRect().width")
    assert round(w()) == 160, w()
    p.click("#aiSheet img[data-apercu]"); p.wait_for_timeout(200); assert round(w()) == 384, w()
    assert not p.query_selector("#aiSheet [data-ticket] span:has-text('✓')"), "toucher l'aperçu ne doit pas cocher le ticket"
    p.screenshot(path=os.environ.get("SORTIE", "/tmp") + "/apercu.png")
    # ticket sans aperçu (autre source) : « pas d'aperçu », pas d'erreur
    urllib.request.urlopen(urllib.request.Request(J + "/api/tickets", json.dumps({"zpl": "^XA^FDx^FS^XZ", "titre": "Autre", "source": "curl", "mode": "file"}).encode(), {"Content-Type": "application/json"}))
    p.wait_for_selector("#aiSheet :text('pas d’aperçu')", timeout=8000)
    assert not erreurs, erreurs
    print("OK")
    b.close()
