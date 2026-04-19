# Wallet75 (iOS Native Swift Wallet)

Wallet75 est maintenant une app **native Swift/SwiftUI** (pas une WebView) avec un style proche Phantom:
- UI wallet iOS glass + animations lentes
- Onglets `Wallet / Market / Settings`
- Pull-to-refresh en balayant vers le bas
- IP du bridge dans `Settings`
- Prix crypto reels (CoinGecko)
- Bridge terminal PC pour changer les soldes instantanement
- Build iOS unsigned `.ipa` via GitHub Actions

## 1) Installation

```bash
npm install
```

## 2) Lancer en local (facultatif pour la partie web)

```bash
npm run dev
```

## 3) Bridge terminal pour modifier les soldes

### Demarrer le serveur d'etat wallet

```bash
npm run wallet:server
```

Serveur par defaut: `http://127.0.0.1:8787`

### Modifier un solde

```bash
npm run wallet:set -- SOL 125
npm run wallet:add -- ETH 0.42
npm run wallet:status
npm run wallet:reset
```

Le fichier d'etat persiste dans `dev-state/wallet.json`.

## 4) Utiliser depuis iPhone (app Swift)

Dans l'app, ouvre l'onglet **Settings** puis configure **IP / URL bridge** avec l'IP locale de ton PC (meme Wi-Fi), exemple:

```text
192.168.1.58:8787
```

Puis clique `Sauver`, et fais un swipe vers le bas pour refresh.

## 5) Build iOS via GitHub Actions (.ipa)

Workflow fourni: `.github/workflows/ios-build.yml`

Declenchement:
- push sur `main` ou `master`
- ou manual `workflow_dispatch`

Artifact genere:
- `MOOD-iOS-Unsigned` contenant `ios/App/App.ipa`

## 6) Initialiser iOS (une fois)

```bash
npm run build
npx cap add ios
npx cap sync ios
```

Ensuite le workflow GitHub peut archiver l'app iOS.

## Notes importantes

- Cette app est un **wallet de demonstration/test** (pas un wallet self-custody complet type MetaMask/Phantom avec seed phrase et signatures on-chain).
- Les prix sont reels, mais les soldes sont pilotes par ton bridge local pour test terminal.
- Pour une production reelle: chiffrement securise, gestion seed, signature TX, audits securite et backend robuste sont indispensables.
