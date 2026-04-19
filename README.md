# Wallet75 (iOS Glass Crypto Wallet)

Wallet75 est une app style iPhone glass/motion qui ressemble a un wallet crypto moderne:
- UI glass + animations lentes
- Prix crypto reels (CoinGecko)
- Vue "all crypto market" (jusqu'a 500 cryptos)
- Bridge terminal PC pour changer les soldes instantanement
- Build iOS unsigned `.ipa` via GitHub Actions

## 1) Installation

```bash
npm install
```

## 2) Lancer en local

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

## 4) Utiliser depuis iPhone

Dans l'app, configure **URL serveur** avec l'IP locale de ton PC (meme Wi-Fi), exemple:

```text
192.168.1.20:8787
```

Puis clique `Connecter`.

## 5) Build iOS via GitHub Actions (.ipa)

Workflow fourni: `.github/workflows/ios-build.yml`

Declenchement:
- push sur `main` ou `master`
- ou manual `workflow_dispatch`

Artifact genere:
- `MOOD-iOS-Unsigned` contenant `ios/App/App.ipa`

## 6) Initialiser iOS Capacitor (une fois)

```bash
npm run build
npx cap add ios
npx cap sync ios
```

Ensuite le workflow GitHub peut archiver l'app iOS.

## Notes importantes

- Cette app est un **wallet de demonstration/test** (pas un wallet self-custody complet type MetaMask/Phantom avec seed phrase et signatures on-chain).
- Les prix sont reels, mais les soldes sont pilotes par ton bridge local pour test.
- Pour une production reelle: chiffrement securise, gestion seed, signature TX, audits securite et backend robuste sont indispensables.
