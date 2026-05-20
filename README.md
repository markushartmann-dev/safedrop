# SafeDrop

**SafeDrop** ist eine selbst gehostete Dateifreigabe-Plattform mit optionaler AES-256-GCM-Verschlüsselung, Benutzerverwaltung und einem integrierten Password-Pusher für Einmal-Secrets. Die App läuft als einzelner Docker-Container ohne externe Abhängigkeiten – keine Cloud, keine Drittanbieter.

---

## Features

### Datei-Upload
- **Chunked Upload** – große Dateien werden in 90-MB-Blöcken übertragen; unterbrechungsresistent
- **Drag & Drop** – Dateien oder ganze Ordner direkt in den Browser ziehen
- **Ordner-Upload** – Ordner werden automatisch als ZIP komprimiert (JSZip, DEFLATE Level 6)
- **Mehrfach-Upload** – beliebig viele Dateien gleichzeitig in einer Session

### Sicherheit & Verschlüsselung
- **AES-256-GCM** – serverseitige Verschlüsselung mit authentifiziertem Chiffrat; die Datei wird nach dem Zusammensetzen auf dem Server verschlüsselt
- **PBKDF2-Schlüsselableitung** – 100.000 Iterationen, SHA-256, 32-Byte-Schlüssel
- **DISA-STIG-Passwortgenerator** – 20 Zeichen, garantierte Zeichenklassen (Groß/Klein/Ziffern/Sonderzeichen), kryptografisch sicher
- **GCM Auth-Tag** – Integritätsprüfung beim Entschlüsseln

### Ablauf & Limits
- **TTL wählbar**: 1 Stunde · 2 h · 4 h · 6 h · 1 Tag · 3 Tage · 7 Tage · 30 Tage · Unbegrenzt
- **Max. Downloads** – optional: Datei wird nach N Downloads automatisch gesperrt
- **Cleanup-Job** – läuft stündlich, löscht abgelaufene Dateien, Sessions und Secrets automatisch

### Benutzerrollen
| Rolle | Beschreibung |
|-------|-------------|
| `admin` | Vollzugriff auf alle Dateien, Nutzer, Logs und Einstellungen |
| `user` | Upload/Download eigener Dateien, Password Pusher |
| `guest` | Anonyme Session (4 h), Passwort verpflichtend, keine Dateiliste |

### Password Pusher
- Einmal-Secrets mit konfigurierbarem **View-Limit** (max. 50) und **TTL**
- Optionale **Passphrase** (PBKDF2-gesichert)
- Secret wird nach letzter Ansicht sofort gelöscht
- Eigene URL: `/push` zum Erstellen, `/p/<token>` zum Abrufen

### Bildergalerie
- Nicht-verschlüsselte Bilder werden in der eigenen Dateiliste als **Galerie-Ansicht** dargestellt
- **Lightbox** mit Tastaturnavigation (← →, Esc)
- Vorschau-Endpunkt ohne Download-Zähler-Inkrement

### Admin-Panel (`/admin`)
| Tab | Inhalt |
|-----|--------|
| Dashboard | Gesamtstatistiken (Nutzer, Dateien, Downloads, Speicher) |
| Benutzer | Anlegen, Sperren/Entsperren, Passwort zurücksetzen, Löschen |
| Dateien | Alle aktiven Dateien, Einzel- und Bulk-Löschen, Admin-Download |
| Transfers | Vollständiges Upload-Protokoll inkl. Gast-Uploads und IP |
| Speicher | Speichernutzung aufgeschlüsselt nach Benutzer |
| Einstellungen | Bandbreitenthrottling (Up/Download) in KB/s |
| System-Log | Ereignisprotokoll der letzten 1.000 Einträge |

### Bandbreitenthrottling
- Separates Token-Bucket-Throttling für **Upload** und **Download**
- Einstellbar per Admin-UI in KB/s (0 = unbegrenzt)
- Standard: 200 Mbit/s (25.600 KB/s)

---

## Tech-Stack

| Komponente | Technologie |
|-----------|------------|
| Backend | Node.js 20 + Express 4 |
| Datenbank | SQLite via `better-sqlite3` |
| Frontend | Vanilla HTML/CSS/JavaScript (kein Framework) |
| Kryptografie | Node.js `crypto` (AES-256-GCM, PBKDF2) |
| Container | Docker (node:20-alpine) |
| Deployment | Docker Compose |

---

## Schnellstart

### Voraussetzungen
- Docker & Docker Compose

### 1. Repository klonen

```bash
git clone https://github.com/markushartmann-dev/safedrop.git
cd safedrop
```

### 2. Container bauen und starten

```bash
docker compose up -d --build
```

Die App ist danach unter `http://localhost:3005` erreichbar.

### 3. Initialen Admin-Account

Beim ersten Start wird automatisch ein Admin-Benutzer angelegt. Das generierte Passwort erscheint im Container-Log:

```bash
docker logs SafeDrop
```

```
╔══════════════════════════════════════════════╗
║       INITIALER ADMIN-BENUTZER ERSTELLT      ║
╠══════════════════════════════════════════════╣
║  Benutzername: admin                         ║
║  Passwort:     <generiertes-passwort>        ║
╚══════════════════════════════════════════════╝
```

**Passwort nach dem ersten Login unbedingt ändern.**

---

## Konfiguration

### compose.yml (Anpassungen)

```yaml
services:
  safedrop:
    ports:
      - "3005:3000"       # Externer Port : Interner Port
    volumes:
      - /your/data/path:/data   # Persistenter Speicher für Dateien + DB
    environment:
      PORT: "3000"
      DATA_DIR: "/data"
```

### Verzeichnisstruktur unter `/data`

```
/data/
├── fileshare.db    # SQLite-Datenbank
├── files/          # Gespeicherte (ggf. verschlüsselte) Dateien
└── chunks/         # Temporäre Upload-Chunks
```

---

## Deployment auf Synology NAS

Das `compose.yml` ist für Synology DSM vorkonfiguriert. Volumes werden aus dem lokalen Dateisystem gemountet – ein Rebuild des Containers ist bei Code-Änderungen **nicht notwendig**, da `server.js`, `public/` und `package.json` als Volumes eingebunden sind.

```yaml
volumes:
  - /volume2/docker/fileshare/data:/data
  - /volume2/docker/fileshare/public:/app/public
  - /volume2/docker/fileshare/server.js:/app/server.js
  - /volume2/docker/fileshare/package.json:/app/package.json
```

---

## Sicherheitshinweise

- Die App setzt `httpOnly`- und `sameSite=lax`-Cookies für Sessions.
- In Produktionsumgebungen sollte die App hinter einem Reverse-Proxy (nginx/Caddy) mit TLS laufen – dann `NODE_ENV=production` setzen, damit Cookies das `Secure`-Flag erhalten.
- Gäste können nur passwortgeschützte Dateien hochladen und haben maximal 4 Stunden TTL.

---

## Lizenz

MIT
