# Memecoin Bot Desk

Papiergeld-Simulation für Solana-Memecoins. Keine Wallet, keine Keys, keine echten Orders.

Die Seite ist statisch: Scanner, Social, Analyst, Sizer, Skeptiker, Risk und Fills laufen im Browser, solange der Tab offen ist. Bank, Positionen, Trades und Feed liegen in `localStorage`. Kurse kommen von DexScreener, 1m-Kerzen von GeckoTerminal.

Live (nach dem Aktivieren von Pages): https://reaperxtrades.github.io/memedesk/

## Pages einschalten

Das mitgelieferte Token kann Pages nicht selbst aktivieren. Einmalig im Repo:

**Settings → Pages → Build and deployment → Source: GitHub Actions**

Der Workflow `.github/workflows/pages.yml` deployed `public/` bei jedem Push auf `main`. Falls der erste Lauf rot ist, nach dem Umschalten der Source neu starten.
