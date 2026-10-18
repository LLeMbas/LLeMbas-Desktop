#!/usr/bin/env python3
"""Write ui/i18n.js: the app's own pages' words in the server's nine languages.

    scripts/gen-i18n.py [path/to/LLeMbas]      (default: ../LLeMbas, or $LEMBAS_SERVER)

The server's catalogues (src/lembas/web/i18n/<lang>.py, keyed by the English sentence) are
the first source: a sentence the server also has is translated as the server translates it,
so the title bar says "Zavrieť" where the server's own Close button does. The sentences only
this app has -- the first-run page, the agent's states -- are in OWN below, and nowhere else.
Keep them few: a new string on the page is a new row here, in all eight languages.

The output is deterministic (languages and keys in a fixed order), so running this twice
writes the same file. ui/i18n.js is committed; this script runs when a string or a server
catalogue changes, not in CI, which has no server checkout.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

# The server checkout is read, not written: no __pycache__ beside its catalogues.
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui" / "i18n.js"
LANGS = ("cs", "de", "es", "fr", "hu", "it", "pl", "sk")  # and "en", the keys themselves

# Every sentence the pages use (ui/index.html, ui/app.js, ui/titlebar.html, ui/titlebar.js),
# as `t("…")` and `data-i18n` name it. `%(name)s` fields are filled in by `t`.
KEYS = (
    # index.html
    "Server",
    "Agent",
    "Project folders",
    "Address of your LLeMbas server",
    "Connect",
    "Sign in there as you would in a browser.",
    "The agent lets agent chats on your server work in this computer's projects. It is the "
    "LLeMbas CLI, built in, running in the background while the app runs.",
    "Link this computer",
    "Start the agent",
    "Open the server",
    "Agent chats from your server can work in these folders and anything inside them — "
    "nowhere else on this computer. Start one in the server's Agents tab, on “Local”.",
    "Add folder…",
    "The most an agent chat may do here",
    "Manual — asks first",
    "Edit — asks before commands",
    "Auto — asks nothing",
    "Plan — changes nothing",
    "A chat asking for more is lowered to this.",
    "Terminal",
    "Let the server open a terminal here",
    "A shell as you, in one of these folders.",
    # app.js
    "The agent is off.",
    "This computer is not linked to the server yet.",
    "The agent is starting…",
    "The agent is running: agent chats can use this computer.",
    "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.",
    "The agent stopped: %(why)s. Trying again shortly.",
    "The agent is connected, but may open no folder yet: add one below.",
    "Link again",
    "Stop the agent",
    "No folder yet: the agent can open nothing. Add the folder of a project.",
    "Remove",
    "Remove %(dir)s",
    "Looking for a LLeMbas server there…",
    # titlebar.html, titlebar.js
    "agent off",
    "not linked",
    "agent starting…",
    "agent running",
    "agent running (service)",
    "agent stopped",
    "agent: no folders",
    "Agent stopped: %(why)s",
    "update",
    "update %(version)s",
    "LLeMbas %(version)s is available (this is %(current)s)",
    "Menu",
    "Minimise",
    "Maximise",
    "Restore",
    "Close",
    "Close (LLeMbas stays in the tray)",
)

# The app's own sentences. The mode names (Manual, Edit, Auto, Plan) stay English, as the
# server's catalogues keep them ("Režim Edit", "Modus Edit"); "Local" is the server's word for
# the device, as the server's catalogue has it.
OWN: dict[str, dict[str, str]] = {
    "cs": {
        "Server": "Server",
        "Project folders": "Složky projektů",
        "Address of your LLeMbas server": "Adresa vašeho serveru LLeMbas",
        "Connect": "Připojit",
        "Sign in there as you would in a browser.": "Přihlaste se tam jako v prohlížeči.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "Agent umožňuje agentním konverzacím na vašem serveru pracovat v projektech na tomto počítači. Je to vestavěné LLeMbas CLI, které běží na pozadí, dokud běží aplikace.",
        "Link this computer": "Propojit tento počítač",
        "Start the agent": "Spustit agenta",
        "Open the server": "Otevřít server",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Agentní konverzace z vašeho serveru mohou pracovat v těchto složkách a ve všem uvnitř nich — nikde jinde na tomto počítači. Spusťte ji na serveru na kartě Agenti, na zařízení „Místní“.",
        "Add folder…": "Přidat složku…",
        "The most an agent chat may do here": "Nejvíc, co tu agentní konverzace smí",
        "Manual — asks first": "Manual — nejdřív se zeptá",
        "Edit — asks before commands": "Edit — ptá se před příkazy",
        "Auto — asks nothing": "Auto — na nic se neptá",
        "Plan — changes nothing": "Plan — nic nemění",
        "A chat asking for more is lowered to this.": "Konverzace, která chce víc, je snížena na tohle.",
        "Let the server open a terminal here": "Dovolit serveru otevřít zde terminál",
        "A shell as you, in one of these folders.": "Shell pod vaším účtem, v jedné z těchto složek.",
        "The agent is off.": "Agent je vypnutý.",
        "This computer is not linked to the server yet.": "Tento počítač ještě není propojený se serverem.",
        "The agent is starting…": "Agent se spouští…",
        "The agent is running: agent chats can use this computer.": "Agent běží: agentní konverzace mohou používat tento počítač.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Služba LLeMbas CLI už tu běží (pid %(pid)s); je agentem tohoto počítače.",
        "The agent stopped: %(why)s. Trying again shortly.": "Agent se zastavil: %(why)s. Za chvíli to zkusí znovu.",
        "The agent is connected, but may open no folder yet: add one below.":
            "Agent je připojený, ale zatím nesmí otevřít žádnou složku: přidejte ji níže.",
        "Link again": "Propojit znovu",
        "Stop the agent": "Zastavit agenta",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Zatím žádná složka: agent nemůže nic otevřít. Přidejte složku projektu.",
        "Remove %(dir)s": "Odebrat %(dir)s",
        "Looking for a LLeMbas server there…": "Hledám tam server LLeMbas…",
        "agent off": "agent vypnutý",
        "not linked": "nepropojeno",
        "agent starting…": "agent se spouští…",
        "agent running": "agent běží",
        "agent running (service)": "agent běží (služba)",
        "agent stopped": "agent zastaven",
        "agent: no folders": "agent: žádné složky",
        "Agent stopped: %(why)s": "Agent se zastavil: %(why)s",
        "update": "aktualizace",
        "update %(version)s": "aktualizace %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "Je k dispozici LLeMbas %(version)s (tohle je %(current)s)",
        "Menu": "Nabídka",
        "Minimise": "Minimalizovat",
        "Maximise": "Maximalizovat",
        "Close (LLeMbas stays in the tray)": "Zavřít (LLeMbas zůstane v oznamovací oblasti)",
    },
    "de": {
        "Server": "Server",
        "Project folders": "Projektordner",
        "Address of your LLeMbas server": "Adresse Ihres LLeMbas-Servers",
        "Connect": "Verbinden",
        "Sign in there as you would in a browser.": "Melden Sie sich dort wie im Browser an.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "Der Agent lässt Agent-Chats auf Ihrem Server in den Projekten dieses Computers arbeiten. Er ist das eingebaute LLeMbas CLI und läuft im Hintergrund, solange die App läuft.",
        "Link this computer": "Diesen Computer verbinden",
        "Start the agent": "Agent starten",
        "Open the server": "Server öffnen",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Agent-Chats von Ihrem Server dürfen in diesen Ordnern und allem darin arbeiten — nirgends sonst auf diesem Computer. Starten Sie einen im Reiter Agenten des Servers, auf „Lokal“.",
        "Add folder…": "Ordner hinzufügen…",
        "The most an agent chat may do here": "Das Meiste, was ein Agent-Chat hier darf",
        "Manual — asks first": "Manual — fragt zuerst",
        "Edit — asks before commands": "Edit — fragt vor Befehlen",
        "Auto — asks nothing": "Auto — fragt nichts",
        "Plan — changes nothing": "Plan — ändert nichts",
        "A chat asking for more is lowered to this.": "Ein Chat, der mehr verlangt, wird hierauf begrenzt.",
        "Let the server open a terminal here": "Dem Server erlauben, hier ein Terminal zu öffnen",
        "A shell as you, in one of these folders.": "Eine Shell als Sie, in einem dieser Ordner.",
        "The agent is off.": "Der Agent ist aus.",
        "This computer is not linked to the server yet.": "Dieser Computer ist noch nicht mit dem Server verbunden.",
        "The agent is starting…": "Der Agent startet…",
        "The agent is running: agent chats can use this computer.": "Der Agent läuft: Agent-Chats können diesen Computer nutzen.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Ein LLeMbas-CLI-Dienst läuft hier bereits (PID %(pid)s); er ist der Agent dieses Computers.",
        "The agent stopped: %(why)s. Trying again shortly.": "Der Agent hat angehalten: %(why)s. Gleich wird es erneut versucht.",
        "The agent is connected, but may open no folder yet: add one below.":
            "Der Agent ist verbunden, darf aber noch keinen Ordner öffnen: Fügen Sie unten einen hinzu.",
        "Link again": "Erneut verbinden",
        "Stop the agent": "Agent anhalten",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Noch kein Ordner: Der Agent kann nichts öffnen. Fügen Sie den Ordner eines Projekts hinzu.",
        "Remove %(dir)s": "%(dir)s entfernen",
        "Looking for a LLeMbas server there…": "Suche dort nach einem LLeMbas-Server…",
        "agent off": "Agent aus",
        "not linked": "nicht verbunden",
        "agent starting…": "Agent startet…",
        "agent running": "Agent läuft",
        "agent running (service)": "Agent läuft (Dienst)",
        "agent stopped": "Agent angehalten",
        "agent: no folders": "Agent: keine Ordner",
        "Agent stopped: %(why)s": "Agent angehalten: %(why)s",
        "update": "Update",
        "update %(version)s": "Update %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "LLeMbas %(version)s ist verfügbar (dies ist %(current)s)",
        "Menu": "Menü",
        "Minimise": "Minimieren",
        "Maximise": "Maximieren",
        "Close (LLeMbas stays in the tray)": "Schließen (LLeMbas bleibt im Benachrichtigungsbereich)",
    },
    "es": {
        "Server": "Servidor",
        "Project folders": "Carpetas de proyectos",
        "Address of your LLeMbas server": "Dirección de su servidor LLeMbas",
        "Connect": "Conectar",
        "Sign in there as you would in a browser.": "Inicie sesión allí como lo haría en un navegador.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "El agente permite que los chats de agente de su servidor trabajen en los proyectos de este ordenador. Es el LLeMbas CLI, integrado, que se ejecuta en segundo plano mientras la aplicación está abierta.",
        "Link this computer": "Vincular este ordenador",
        "Start the agent": "Iniciar el agente",
        "Open the server": "Abrir el servidor",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Los chats de agente de su servidor pueden trabajar en estas carpetas y en todo lo que contienen — en ningún otro lugar de este ordenador. Inicie uno en la pestaña Agentes del servidor, en «Local».",
        "Add folder…": "Añadir carpeta…",
        "The most an agent chat may do here": "Lo máximo que un chat de agente puede hacer aquí",
        "Manual — asks first": "Manual — pregunta primero",
        "Edit — asks before commands": "Edit — pregunta antes de los comandos",
        "Auto — asks nothing": "Auto — no pregunta nada",
        "Plan — changes nothing": "Plan — no cambia nada",
        "A chat asking for more is lowered to this.": "Un chat que pida más se limita a esto.",
        "Let the server open a terminal here": "Permitir que el servidor abra un terminal aquí",
        "A shell as you, in one of these folders.": "Un shell con su usuario, en una de estas carpetas.",
        "The agent is off.": "El agente está apagado.",
        "This computer is not linked to the server yet.": "Este ordenador aún no está vinculado al servidor.",
        "The agent is starting…": "El agente se está iniciando…",
        "The agent is running: agent chats can use this computer.": "El agente está en marcha: los chats de agente pueden usar este ordenador.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Ya se está ejecutando aquí un servicio de LLeMbas CLI (pid %(pid)s); es el agente de este ordenador.",
        "The agent stopped: %(why)s. Trying again shortly.": "El agente se detuvo: %(why)s. Se volverá a intentar en breve.",
        "The agent is connected, but may open no folder yet: add one below.":
            "El agente está conectado, pero aún no puede abrir ninguna carpeta: añada una abajo.",
        "Link again": "Vincular de nuevo",
        "Stop the agent": "Detener el agente",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Aún no hay ninguna carpeta: el agente no puede abrir nada. Añada la carpeta de un proyecto.",
        "Remove %(dir)s": "Quitar %(dir)s",
        "Looking for a LLeMbas server there…": "Buscando un servidor LLeMbas allí…",
        "agent off": "agente apagado",
        "not linked": "no vinculado",
        "agent starting…": "agente iniciando…",
        "agent running": "agente en marcha",
        "agent running (service)": "agente en marcha (servicio)",
        "agent stopped": "agente detenido",
        "agent: no folders": "agente: sin carpetas",
        "Agent stopped: %(why)s": "El agente se detuvo: %(why)s",
        "update": "actualizar",
        "update %(version)s": "actualizar a %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "LLeMbas %(version)s está disponible (esta es la %(current)s)",
        "Menu": "Menú",
        "Minimise": "Minimizar",
        "Maximise": "Maximizar",
        "Close (LLeMbas stays in the tray)": "Cerrar (LLeMbas sigue en la bandeja del sistema)",
    },
    "fr": {
        "Server": "Serveur",
        "Project folders": "Dossiers de projets",
        "Address of your LLeMbas server": "Adresse de votre serveur LLeMbas",
        "Connect": "Se connecter",
        "Sign in there as you would in a browser.": "Connectez-vous là-bas comme dans un navigateur.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "L'agent permet aux conversations d'agent de votre serveur de travailler dans les projets de cet ordinateur. C'est le LLeMbas CLI, intégré, qui tourne en arrière-plan tant que l'application est ouverte.",
        "Link this computer": "Relier cet ordinateur",
        "Start the agent": "Démarrer l'agent",
        "Open the server": "Ouvrir le serveur",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Les conversations d'agent de votre serveur peuvent travailler dans ces dossiers et tout ce qu'ils contiennent — nulle part ailleurs sur cet ordinateur. Démarrez-en une dans l'onglet Agents du serveur, sur « Local ».",
        "Add folder…": "Ajouter un dossier…",
        "The most an agent chat may do here": "Le maximum qu'une conversation d'agent peut faire ici",
        "Manual — asks first": "Manual — demande d'abord",
        "Edit — asks before commands": "Edit — demande avant les commandes",
        "Auto — asks nothing": "Auto — ne demande rien",
        "Plan — changes nothing": "Plan — ne change rien",
        "A chat asking for more is lowered to this.": "Une conversation qui en demande plus est ramenée à ceci.",
        "Let the server open a terminal here": "Laisser le serveur ouvrir un terminal ici",
        "A shell as you, in one of these folders.": "Un shell en votre nom, dans l'un de ces dossiers.",
        "The agent is off.": "L'agent est arrêté.",
        "This computer is not linked to the server yet.": "Cet ordinateur n'est pas encore relié au serveur.",
        "The agent is starting…": "L'agent démarre…",
        "The agent is running: agent chats can use this computer.": "L'agent tourne : les conversations d'agent peuvent utiliser cet ordinateur.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Un service LLeMbas CLI tourne déjà ici (pid %(pid)s) ; c'est l'agent de cet ordinateur.",
        "The agent stopped: %(why)s. Trying again shortly.": "L'agent s'est arrêté : %(why)s. Nouvel essai sous peu.",
        "The agent is connected, but may open no folder yet: add one below.":
            "L'agent est connecté, mais ne peut encore ouvrir aucun dossier : ajoutez-en un ci-dessous.",
        "Link again": "Relier à nouveau",
        "Stop the agent": "Arrêter l'agent",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Aucun dossier pour l'instant : l'agent ne peut rien ouvrir. Ajoutez le dossier d'un projet.",
        "Remove %(dir)s": "Retirer %(dir)s",
        "Looking for a LLeMbas server there…": "Recherche d'un serveur LLeMbas à cette adresse…",
        "agent off": "agent arrêté",
        "not linked": "non relié",
        "agent starting…": "agent en démarrage…",
        "agent running": "agent actif",
        "agent running (service)": "agent actif (service)",
        "agent stopped": "agent interrompu",
        "agent: no folders": "agent : aucun dossier",
        "Agent stopped: %(why)s": "L'agent s'est arrêté : %(why)s",
        "update": "mise à jour",
        "update %(version)s": "mise à jour %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "LLeMbas %(version)s est disponible (ceci est la %(current)s)",
        "Menu": "Menu",
        "Minimise": "Réduire",
        "Maximise": "Agrandir",
        "Close (LLeMbas stays in the tray)": "Fermer (LLeMbas reste dans la zone de notification)",
    },
    "hu": {
        "Server": "Kiszolgáló",
        "Project folders": "Projektmappák",
        "Address of your LLeMbas server": "A LLeMbas-kiszolgáló címe",
        "Connect": "Csatlakozás",
        "Sign in there as you would in a browser.": "Jelentkezzen be ott úgy, mint egy böngészőben.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "Az ügynök lehetővé teszi, hogy a kiszolgálón futó ügynök-csevegések ennek a számítógépnek a projektjeiben dolgozzanak. Ez a beépített LLeMbas CLI, amely a háttérben fut, amíg az alkalmazás fut.",
        "Link this computer": "A számítógép összekapcsolása",
        "Start the agent": "Ügynök indítása",
        "Open the server": "Kiszolgáló megnyitása",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "A kiszolgáló ügynök-csevegései ezekben a mappákban és a bennük lévőkben dolgozhatnak — a számítógépen máshol nem. Indítson egyet a kiszolgáló Ügynökök lapján, a „Helyi” eszközön.",
        "Add folder…": "Mappa hozzáadása…",
        "The most an agent chat may do here": "A legtöbb, amit egy ügynök-csevegés itt tehet",
        "Manual — asks first": "Manual — előbb kérdez",
        "Edit — asks before commands": "Edit — parancsok előtt kérdez",
        "Auto — asks nothing": "Auto — semmit nem kérdez",
        "Plan — changes nothing": "Plan — semmit nem változtat",
        "A chat asking for more is lowered to this.": "Az ennél többet kérő csevegés erre korlátozódik.",
        "Let the server open a terminal here": "A kiszolgáló nyithasson itt terminált",
        "A shell as you, in one of these folders.": "Egy shell az Ön nevében, ezek egyik mappájában.",
        "The agent is off.": "Az ügynök ki van kapcsolva.",
        "This computer is not linked to the server yet.": "Ez a számítógép még nincs összekapcsolva a kiszolgálóval.",
        "The agent is starting…": "Az ügynök indul…",
        "The agent is running: agent chats can use this computer.": "Az ügynök fut: az ügynök-csevegések használhatják ezt a számítógépet.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Itt már fut egy LLeMbas CLI szolgáltatás (pid %(pid)s); ez a számítógép ügynöke.",
        "The agent stopped: %(why)s. Trying again shortly.": "Az ügynök leállt: %(why)s. Hamarosan újra próbálja.",
        "The agent is connected, but may open no folder yet: add one below.":
            "Az ügynök csatlakozott, de még egy mappát sem nyithat meg: adjon hozzá egyet lent.",
        "Link again": "Újra összekapcsolás",
        "Stop the agent": "Ügynök leállítása",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Még nincs mappa: az ügynök semmit nem nyithat meg. Adja hozzá egy projekt mappáját.",
        "Remove %(dir)s": "%(dir)s eltávolítása",
        "Looking for a LLeMbas server there…": "LLeMbas-kiszolgáló keresése ott…",
        "agent off": "ügynök kikapcsolva",
        "not linked": "nincs összekapcsolva",
        "agent starting…": "ügynök indul…",
        "agent running": "ügynök fut",
        "agent running (service)": "ügynök fut (szolgáltatás)",
        "agent stopped": "ügynök leállt",
        "agent: no folders": "ügynök: nincs mappa",
        "Agent stopped: %(why)s": "Az ügynök leállt: %(why)s",
        "update": "frissítés",
        "update %(version)s": "frissítés: %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "Elérhető a LLeMbas %(version)s (ez a %(current)s)",
        "Menu": "Menü",
        "Minimise": "Kis méret",
        "Maximise": "Teljes méret",
        "Close (LLeMbas stays in the tray)": "Bezárás (a LLeMbas a tálcán marad)",
    },
    "it": {
        "Server": "Server",
        "Project folders": "Cartelle dei progetti",
        "Address of your LLeMbas server": "Indirizzo del tuo server LLeMbas",
        "Connect": "Connetti",
        "Sign in there as you would in a browser.": "Accedi lì come faresti in un browser.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "L'agente permette alle chat agente del tuo server di lavorare nei progetti di questo computer. È il LLeMbas CLI, integrato, in esecuzione in background finché l'app è aperta.",
        "Link this computer": "Collega questo computer",
        "Start the agent": "Avvia l'agente",
        "Open the server": "Apri il server",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Le chat agente del tuo server possono lavorare in queste cartelle e in tutto ciò che contengono — in nessun altro posto di questo computer. Avviane una nella scheda Agenti del server, su “Locale”.",
        "Add folder…": "Aggiungi cartella…",
        "The most an agent chat may do here": "Il massimo che una chat agente può fare qui",
        "Manual — asks first": "Manual — chiede prima",
        "Edit — asks before commands": "Edit — chiede prima dei comandi",
        "Auto — asks nothing": "Auto — non chiede nulla",
        "Plan — changes nothing": "Plan — non cambia nulla",
        "A chat asking for more is lowered to this.": "Una chat che chiede di più viene limitata a questo.",
        "Let the server open a terminal here": "Lascia che il server apra un terminale qui",
        "A shell as you, in one of these folders.": "Una shell con il tuo utente, in una di queste cartelle.",
        "The agent is off.": "L'agente è spento.",
        "This computer is not linked to the server yet.": "Questo computer non è ancora collegato al server.",
        "The agent is starting…": "L'agente si sta avviando…",
        "The agent is running: agent chats can use this computer.": "L'agente è in esecuzione: le chat agente possono usare questo computer.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Un servizio LLeMbas CLI è già in esecuzione qui (pid %(pid)s); è l'agente di questo computer.",
        "The agent stopped: %(why)s. Trying again shortly.": "L'agente si è fermato: %(why)s. Tra poco riprova.",
        "The agent is connected, but may open no folder yet: add one below.":
            "L'agente è connesso, ma non può ancora aprire nessuna cartella: aggiungine una qui sotto.",
        "Link again": "Collega di nuovo",
        "Stop the agent": "Ferma l'agente",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Ancora nessuna cartella: l'agente non può aprire nulla. Aggiungi la cartella di un progetto.",
        "Remove %(dir)s": "Rimuovi %(dir)s",
        "Looking for a LLeMbas server there…": "Cerco un server LLeMbas lì…",
        "agent off": "agente spento",
        "not linked": "non collegato",
        "agent starting…": "agente in avvio…",
        "agent running": "agente attivo",
        "agent running (service)": "agente attivo (servizio)",
        "agent stopped": "agente fermato",
        "agent: no folders": "agente: nessuna cartella",
        "Agent stopped: %(why)s": "L'agente si è fermato: %(why)s",
        "update": "aggiorna",
        "update %(version)s": "aggiorna a %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "È disponibile LLeMbas %(version)s (questa è la %(current)s)",
        "Menu": "Menu",
        "Minimise": "Riduci a icona",
        "Maximise": "Ingrandisci",
        "Close (LLeMbas stays in the tray)": "Chiudi (LLeMbas resta nell'area di notifica)",
    },
    "pl": {
        "Server": "Serwer",
        "Project folders": "Foldery projektów",
        "Address of your LLeMbas server": "Adres Twojego serwera LLeMbas",
        "Connect": "Połącz",
        "Sign in there as you would in a browser.": "Zaloguj się tam tak jak w przeglądarce.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "Agent pozwala czatom agenta z Twojego serwera pracować w projektach na tym komputerze. To wbudowane LLeMbas CLI, działające w tle, dopóki działa aplikacja.",
        "Link this computer": "Połącz ten komputer",
        "Start the agent": "Uruchom agenta",
        "Open the server": "Otwórz serwer",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Czaty agenta z Twojego serwera mogą pracować w tych folderach i we wszystkim, co zawierają — nigdzie indziej na tym komputerze. Uruchom czat na karcie Agenci na serwerze, na urządzeniu „Lokalne”.",
        "Add folder…": "Dodaj folder…",
        "The most an agent chat may do here": "Najwięcej, co czat agenta może tu zrobić",
        "Manual — asks first": "Manual — najpierw pyta",
        "Edit — asks before commands": "Edit — pyta przed poleceniami",
        "Auto — asks nothing": "Auto — o nic nie pyta",
        "Plan — changes nothing": "Plan — niczego nie zmienia",
        "A chat asking for more is lowered to this.": "Czat, który prosi o więcej, zostaje ograniczony do tego.",
        "Let the server open a terminal here": "Pozwól serwerowi otworzyć tu terminal",
        "A shell as you, in one of these folders.": "Powłoka na Twoim koncie, w jednym z tych folderów.",
        "The agent is off.": "Agent jest wyłączony.",
        "This computer is not linked to the server yet.": "Ten komputer nie jest jeszcze połączony z serwerem.",
        "The agent is starting…": "Agent się uruchamia…",
        "The agent is running: agent chats can use this computer.": "Agent działa: czaty agenta mogą używać tego komputera.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Usługa LLeMbas CLI już tu działa (pid %(pid)s); jest agentem tego komputera.",
        "The agent stopped: %(why)s. Trying again shortly.": "Agent się zatrzymał: %(why)s. Za chwilę spróbuje ponownie.",
        "The agent is connected, but may open no folder yet: add one below.":
            "Agent jest połączony, ale nie może jeszcze otworzyć żadnego folderu: dodaj go poniżej.",
        "Link again": "Połącz ponownie",
        "Stop the agent": "Zatrzymaj agenta",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Nie ma jeszcze folderu: agent nie może nic otworzyć. Dodaj folder projektu.",
        "Remove %(dir)s": "Usuń %(dir)s",
        "Looking for a LLeMbas server there…": "Szukam tam serwera LLeMbas…",
        "agent off": "agent wyłączony",
        "not linked": "niepołączony",
        "agent starting…": "agent się uruchamia…",
        "agent running": "agent działa",
        "agent running (service)": "agent działa (usługa)",
        "agent stopped": "agent zatrzymany",
        "agent: no folders": "agent: brak folderów",
        "Agent stopped: %(why)s": "Agent się zatrzymał: %(why)s",
        "update": "aktualizacja",
        "update %(version)s": "aktualizacja %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "Dostępny jest LLeMbas %(version)s (to jest %(current)s)",
        "Menu": "Menu",
        "Minimise": "Minimalizuj",
        "Maximise": "Maksymalizuj",
        "Close (LLeMbas stays in the tray)": "Zamknij (LLeMbas zostaje w zasobniku systemowym)",
    },
    "sk": {
        "Server": "Server",
        "Project folders": "Priečinky projektov",
        "Address of your LLeMbas server": "Adresa vášho servera LLeMbas",
        "Connect": "Pripojiť",
        "Sign in there as you would in a browser.": "Prihláste sa tam ako v prehliadači.",
        "The agent lets agent chats on your server work in this computer's projects. It is the LLeMbas CLI, built in, running in the background while the app runs.":
            "Agent umožňuje agentským konverzáciám na vašom serveri pracovať v projektoch na tomto počítači. Je to vstavané LLeMbas CLI, ktoré beží na pozadí, kým beží aplikácia.",
        "Link this computer": "Prepojiť tento počítač",
        "Start the agent": "Spustiť agenta",
        "Open the server": "Otvoriť server",
        "Agent chats from your server can work in these folders and anything inside them — nowhere else on this computer. Start one in the server's Agents tab, on “Local”.":
            "Agentské konverzácie z vášho servera môžu pracovať v týchto priečinkoch a vo všetkom, čo obsahujú — nikde inde na tomto počítači. Spustite ju na serveri na karte Agenti, na zariadení „Lokálny“.",
        "Add folder…": "Pridať priečinok…",
        "The most an agent chat may do here": "Najviac, čo tu agentská konverzácia smie",
        "Manual — asks first": "Manual — najprv sa opýta",
        "Edit — asks before commands": "Edit — pýta sa pred príkazmi",
        "Auto — asks nothing": "Auto — na nič sa nepýta",
        "Plan — changes nothing": "Plan — nič nemení",
        "A chat asking for more is lowered to this.": "Konverzácia, ktorá chce viac, je znížená na toto.",
        "Let the server open a terminal here": "Dovoliť serveru otvoriť tu terminál",
        "A shell as you, in one of these folders.": "Shell pod vaším účtom, v jednom z týchto priečinkov.",
        "The agent is off.": "Agent je vypnutý.",
        "This computer is not linked to the server yet.": "Tento počítač ešte nie je prepojený so serverom.",
        "The agent is starting…": "Agent sa spúšťa…",
        "The agent is running: agent chats can use this computer.": "Agent beží: agentské konverzácie môžu používať tento počítač.",
        "A LLeMbas CLI service already runs here (pid %(pid)s); it is this computer's agent.":
            "Služba LLeMbas CLI tu už beží (pid %(pid)s); je agentom tohto počítača.",
        "The agent stopped: %(why)s. Trying again shortly.": "Agent sa zastavil: %(why)s. O chvíľu to skúsi znova.",
        "The agent is connected, but may open no folder yet: add one below.":
            "Agent je pripojený, ale zatiaľ nesmie otvoriť žiadny priečinok: pridajte ho nižšie.",
        "Link again": "Prepojiť znova",
        "Stop the agent": "Zastaviť agenta",
        "No folder yet: the agent can open nothing. Add the folder of a project.":
            "Zatiaľ žiadny priečinok: agent nemôže nič otvoriť. Pridajte priečinok projektu.",
        "Remove %(dir)s": "Odstrániť %(dir)s",
        "Looking for a LLeMbas server there…": "Hľadám tam server LLeMbas…",
        "agent off": "agent vypnutý",
        "not linked": "neprepojené",
        "agent starting…": "agent sa spúšťa…",
        "agent running": "agent beží",
        "agent running (service)": "agent beží (služba)",
        "agent stopped": "agent zastavený",
        "agent: no folders": "agent: žiadne priečinky",
        "Agent stopped: %(why)s": "Agent sa zastavil: %(why)s",
        "update": "aktualizácia",
        "update %(version)s": "aktualizácia %(version)s",
        "LLeMbas %(version)s is available (this is %(current)s)": "Je k dispozícii LLeMbas %(version)s (toto je %(current)s)",
        "Menu": "Ponuka",
        "Minimise": "Minimalizovať",
        "Maximise": "Maximalizovať",
        "Close (LLeMbas stays in the tray)": "Zavrieť (LLeMbas zostane v oznamovacej oblasti)",
    },
}

FIELD = re.compile(r"%\((\w+)\)s")


def server_catalogue(server: Path, lang: str) -> dict[str, str]:
    """The server's MESSAGES for `lang`: the module loaded from its file, nothing imported."""
    path = server / "src" / "lembas" / "web" / "i18n" / f"{lang}.py"
    if not path.is_file():
        sys.exit(f"gen-i18n: {path} is missing: is {server} the LLeMbas server checkout?")
    spec = importlib.util.spec_from_file_location(f"lembas_i18n_{lang}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    messages = getattr(module, "MESSAGES", None)
    if not isinstance(messages, dict):
        sys.exit(f"gen-i18n: {path} has no MESSAGES")
    return messages


def main() -> None:
    server = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LEMBAS_SERVER", ROOT.parent / "LLeMbas"))
    catalogue: dict[str, dict[str, str]] = {}
    problems = 0
    for lang in LANGS:
        theirs = server_catalogue(server, lang)
        ours = OWN.get(lang, {})
        table: dict[str, str] = {}
        from_server = 0
        for key in KEYS:
            text = theirs.get(key)
            if text:
                from_server += 1
            else:
                text = ours.get(key)
            if not text:
                print(f"gen-i18n: {lang}: no translation of {key!r} (English will show)", file=sys.stderr)
                problems += 1
                continue
            if set(FIELD.findall(text)) != set(FIELD.findall(key)):
                print(f"gen-i18n: {lang}: the fields of {text!r} do not match {key!r}", file=sys.stderr)
                problems += 1
                continue
            table[key] = text
        for key in ours:
            if key not in KEYS:
                print(f"gen-i18n: {lang}: OWN has {key!r}, which no page uses", file=sys.stderr)
                problems += 1
        catalogue[lang] = table
        print(f"gen-i18n: {lang}: {len(table)} of {len(KEYS)} ({from_server} from the server)")

    body = json.dumps(catalogue, ensure_ascii=False, indent=2, sort_keys=True)
    out = (
        "// The app's own pages' words in the server's languages. GENERATED by scripts/gen-i18n.py:\n"
        "// the sentences the server also has come from its web/i18n catalogues, the rest from the\n"
        "// script's own table. Do not edit; run the script.\n"
        "//\n"
        "// `t(text, fields)` is the page's English with `%(name)s` fields, as on the server; a\n"
        "// missing entry is the English. The language is the system's (navigator.language),\n"
        "// English unless it is one of these. Elements marked `data-i18n` (their text) and\n"
        "// `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder` (that attribute)\n"
        "// are translated once the page is parsed; this script is deferred, before the page's.\n"
        '"use strict"\n'
        "\n"
        f"const LEMBAS_I18N = {body}\n"
        "\n"
        "const LEMBAS_LANG = (() => {\n"
        '  const code = String(navigator.language || "").slice(0, 2).toLowerCase()\n'
        '  return Object.prototype.hasOwnProperty.call(LEMBAS_I18N, code) ? code : "en"\n'
        "})()\n"
        "document.documentElement.lang = LEMBAS_LANG\n"
        "\n"
        "function t(text, fields) {\n"
        '  const key = String(text).replace(/\\s+/g, " ").trim()\n'
        "  const table = LEMBAS_I18N[LEMBAS_LANG] || {}\n"
        "  const out = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key\n"
        "  if (!fields) return out\n"
        "  return out.replace(/%\\((\\w+)\\)s/g, (all, name) =>\n"
        "    Object.prototype.hasOwnProperty.call(fields, name) ? String(fields[name]) : all)\n"
        "}\n"
        "\n"
        "function translatePage() {\n"
        '  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.textContent)\n'
        '  for (const attr of ["title", "aria-label", "placeholder"]) {\n'
        "    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {\n"
        "      el.setAttribute(attr, t(el.getAttribute(attr)))\n"
        "    }\n"
        "  }\n"
        "}\n"
        'if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", translatePage)\n'
        "else translatePage()\n"
    )
    OUT.write_text(out, encoding="utf-8")
    print(f"gen-i18n: wrote {OUT.relative_to(ROOT)} ({len(LANGS)} languages, {len(KEYS)} sentences)")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
