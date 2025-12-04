# Mitt Spel – Online rumspel (Node.js + Socket.io)

Ett litet multiplayer-spel inspirerat av Habbo Hotel, byggt med **Node.js**, **Express** och **Socket.io**.  
Spelare kan skapa konton, logga in, gå runt i isometriska rum, chatta, redigera egna rum, spela minispel och använda en enkel shop.

> OBS: Detta projekt är under utveckling och är tänkt som ett hobby-/lärandeprojekt.

---

## Funktioner

### 🔐 Konton & inloggning

- Skapa konto med **användarnamn + lösenord**
- Lösenord sparas **hashat** i `users.json` via `bcryptjs` (inte i klartext)
- Endast **1 inloggning per konto åt gången**  
  - Loggar du in från ett annat ställe loggas den gamla sessionen ut

### 👤 Spelare & utseende

- Varje användare har:
  - `username`
  - `coins`
  - `appearance` (hudfärg, tröja, byxor)
  - `items` (ägda shop-items, t.ex. tärningsruta)
- Utseende syns på din gubbe i spelet
- Du kan ändra färger via **Inställningar** (hud, tröja, byxor)  
  → det sparas i `users.json`

### 🌍 Rum & världar

- Flera rum:
  - Standardrum: **Lobby**
  - Spelare kan skapa **egna rum** (rooms)
- Rum sparas i `rooms.json` med:
  - `id`, `name`, `owner`, `map`
- Varje rum har en **tile-baserad karta** (20x15 tiles)

Tiles:

- `0` – golv (walkable)
- `1` – vägg (block)
- `2` – matta (walkable)
- `3` – block/möbel (block)
- `4` – guld-ruta (startar 4-i-rad)
- `5` – tärningsruta (kan triggas för att slå en tärning)

### 🛋 Rum-editor

- **Rumsägaren** kan slå på *"Redigera rum"*
- Klick på map i edit-läge cyklar tile-typen (0 → 1 → 2 → 3 → 4 → 5 → 0 …)
- Ändringar sparas i `rooms.json` och skickas ut till alla spelare i rummet
- Specialregler:
  - Endast ägare får redigera (om rummet har `owner`)
  - Tile `5` (tärningsruta) kräver att ägaren har köpt item `dice_tile` i shoppen

### 🧍‍♂️ Rörelse & rendering

- Canvas-klient i `index.html`
- **Isometrisk 2D-vy** över rummets tiles
- Spelare rör sig på rutnät (tiles), WASD / piltangenter
- **Smooth movement**:
  - Varje steg interpoleras (lerp) över ~180 ms
  - Får en mjukare känsla än hoppiga förflyttningar

### 💬 Chatt & bubblor

- Textchatt under spelet
- Meddelanden visas både:
  - i chatboxen
  - som **chattbubblor över spelarnas huvuden** en kort tid

### 🛒 Shop & coins

- Varje spelare har `coins` (standard t.ex. 100)
- Enkel shop (endpoint: `/api/shop`) med items, t.ex.:
  - `outfit_blue`, `outfit_red`, `outfit_green`, `outfit_purple`
  - `dice_tile` – låser upp möjligheten att placera tärningsrutor i egna rum
- Köp:
  - Drar coins
  - Uppdaterar `appearance` (för outfits)
  - Uppdaterar `items` (för t.ex. `dice_tile`)
  - Uppdaterad info sparas i `users.json`

### 🎲 Tärningsruta (dice tile)

- Tile `5` = tärningsruta
- Rumsägaren (som äger `dice_tile` i shoppen) kan:
  - I editor-läge lägga ut tärningsrutor i sitt rum
- **Högerklick** på en tärningsruta:
  - Skickar ett `diceRoll`-event
  - Servern genererar ett tal `1–6`
  - Alla i rummet ser:
    - meddelande i chatten: vem slog vad
    - kort chattbubbla över spelaren med t.ex. `🎲 4`

### 🔷 4-i-rad minigame

- Tile `4` = guld-ruta
- **Högerklick** på guld-rutan i ett rum:
  - Du får skriva namnet på spelaren du vill bjuda in (måste vara i samma rum)
- Motståndaren får en inbjudan och kan acceptera
- Egen 4-i-rad-modal:
  - 7 kolumner, 6 rader
  - Klick på kolumn för att släppa bricka
  - Servern:
    - uppdaterar brädet
    - kollar vinst (4 i rad, horisontellt/vertikalt/diagonal)
    - kollar oavgjort (brädet fullt)
- När någon vinner / lämnar:
  - Bägge klienter får resultat och spelet stängs

---

## Teknisk översikt

**Backend**

- `server.js`
  - Node.js + Express + Socket.io
  - HTTP-server + WebSocket-kommunikation
  - API-endpoints:
    - `POST /api/register`
    - `POST /api/login`
    - `POST /api/updateAppearance`
    - `GET  /api/shop`
    - `POST /api/buyItem`
  - Hanterar:
    - konton & hashade lösenord (bcryptjs)
    - inloggade användare (endast 1 session per konto)
    - spelare i rooms
    - rörelse, chatt, rum-editor
    - 4-i-rad-spel
    - tärningsrutor
  - Sparar data till:
    - `users.json`
    - `rooms.json`

**Frontend**

- `index.html`
  - Canvas-baserad client med plain JavaScript
  - Isometrisk rendering av tiles
  - Client state för:
    - egen spelare
    - andra spelare
    - karta (tiles)
    - room-lista
    - shop & coins
    - 4-i-rad
    - tärningsrutor
  - Kommunicerar med server via Socket.io + fetch API

---

## Kom igång lokalt

### 1. Klona repo

```bash
git clone https://github.com/DITT-ANVÄNDARNAMN/mitt-spel.git
cd mitt-spel
