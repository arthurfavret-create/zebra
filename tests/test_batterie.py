"""Batterie de la Zebra dans l'en-tête de Zebra Studio (lue dans /api/etat de Jarvis) : vrai jarvis-print + Chromium.
  docker run --rm --network host -v ~/projets:/p:ro -e HOME=/tmp mcr.microsoft.com/playwright/python:v1.49.0-noble sh -c \
   'pip install -q --target /deps -r /p/jarvis-print/requirements.txt playwright==1.49.0 && python3 /p/zebra/tests/test_batterie.py'
"""
import os, subprocess, sys, tempfile, threading, time
sys.path.insert(0, "/deps"); sys.path.insert(0, "/p/jarvis-print")
D = tempfile.mkdtemp()
os.environ.update(CORS_ORIGINE="http://127.0.0.1:18081", DONNEES=D, IMPRIMANTE_CHEMIN=D + "/absente")
import uvicorn
from app import main
threading.Thread(target=uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=18091, log_level="warning")).run, daemon=True).start()
subprocess.Popen([sys.executable, "-m", "http.server", "18081", "-d", "/p/zebra"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
J = "http://127.0.0.1:18091"
imp = main.imprimante
def regler(dispo, bat):
    imp.disponible, imp.voie, imp.batterie = dispo, "bluetooth" if dispo else None, bat
    main.file.publier()
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for dest in ("jarvis", "bluetooth"):          # la batterie reste visible même en Bluetooth direct
        for largeur in (360, 375, 820):
            ctx = b.new_context(viewport={"width": largeur, "height": 800}); p = ctx.new_page()
            erreurs = []; p.on("pageerror", lambda e: erreurs.append(str(e)))
            regler(False, None)
            p.add_init_script(f"localStorage.setItem('zebra-jarvis','{J}'); localStorage.setItem('zebra-dest','{dest}');")
            p.goto("http://127.0.0.1:18081/index.html"); p.wait_for_timeout(1200)
            assert p.is_hidden("#batZebra"), "inconnue : rien d'affiché"
            regler(True, {"pourcent": 84, "charge": False}); p.wait_for_timeout(600)
            assert p.inner_text("#batZebra") == "🔋 84 %", p.inner_text("#batZebra")
            regler(True, {"pourcent": 84, "charge": True}); p.wait_for_timeout(600)
            assert p.inner_text("#batZebra") == "⚡ 84 %"
            if largeur == 375 and dest == "jarvis":
                p.screenshot(path=os.environ.get("SORTIE", "/tmp") + "/batterie-375.png", clip={"x": 0, "y": 0, "width": 375, "height": 120})
            assert p.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"défilement horizontal à {largeur} px"
            assert p.evaluate("(() => { const t = document.querySelector('header .titre'), h = document.querySelector('header h1'); return h.scrollWidth <= t.clientWidth + 1; })()"), f"titre écrasé à {largeur} px"
            regler(True, None); p.wait_for_timeout(600)
            assert p.is_hidden("#batZebra"), "valeur inconnue : rien d'affiché"
            regler(True, {"pourcent": 62, "charge": False}); p.wait_for_timeout(600)
            assert p.inner_text("#batZebra") == "🔋 62 %"
            assert not erreurs, erreurs
            ctx.close()
    # Jarvis ne répond pas : rien
    ctx = b.new_context(viewport={"width": 375, "height": 800}); p = ctx.new_page()
    p.add_init_script("localStorage.setItem('zebra-jarvis','http://127.0.0.1:1'); localStorage.setItem('zebra-dest','jarvis');")
    p.goto("http://127.0.0.1:18081/index.html"); p.wait_for_timeout(1500)
    assert p.is_hidden("#batZebra")
    print("OK")
    b.close()
