# Base reward proof manifests

The base reward keeper (`keeper/base-keeper.mjs`) writes one JSON file per
StockRewardVault here, named `<vault-address-lowercase>.json`. Each holds the
vault's posted Merkle epochs and, per epoch, every holder's leaf + proof so the
site can let holders claim their paired-stock reward.

These are generated — do not edit by hand.
