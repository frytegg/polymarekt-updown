Stratégie Arb Polymarket Up/Down - MVP
Principe
Exploiter le lag entre Binance (price discovery) et Polymarket (sentiment retail) pour acheter YES ou NO quand le marché est mispriced vs la fair value calculée depuis Binance.

Données nécessaires

Binance WS : prix BTC realtime (BTCUSDT)
Polymarket WS/API : orderbook YES/NO du marché actif
Chainlink : prix strike au début de la période (ou via Polymarket API)
Timestamp : temps restant jusqu'à résolution


Calcul Fair Value
Le marché résout UP si prix_fin ≥ prix_début, sinon DOWN.
On modélise le log-prix comme un brownian motion :
dS = σ × S × dW
La probabilité que le prix finisse au-dessus du strike :
P(UP) = Φ( d )

où d = ln(S_current / S_strike) / (σ × √τ)

avec:
  S_current = prix Binance actuel
  S_strike  = prix au début de la période (fixé)
  σ         = volatilité annualisée (≈ 50-70% pour BTC)
  τ         = temps restant en années
  Φ         = CDF de la loi normale standard
Conversion du temps :
τ = seconds_remaining / (365 × 24 × 3600)

Exemple: 5 min restantes
τ = 300 / 31,536,000 = 0.0000095
Conversion de la vol :
σ_15min ≈ σ_annual / √(365 × 24 × 4)
        ≈ 0.60 / 187
        ≈ 0.32% par période de 15 min
Exemple numérique :
Strike     = 92,527.89
BTC actuel = 92,651.60  (+0.13%)
Time left  = 4 min 32 sec = 272 sec
σ_annual   = 60%

τ = 272 / 31,536,000 = 8.63e-6
σ√τ = 0.60 × √(8.63e-6) = 0.00176 = 0.176%

d = ln(92651.60 / 92527.89) / 0.00176
  = 0.00134 / 0.00176
  = 0.76

P(UP) = Φ(0.76) = 0.776 = 77.6%
P(DOWN) = 22.4%


---

### Logique de trade
```
1. Récupérer prix Binance
2. Calculer fair_yes, fair_no
3. Lire best ask YES et best ask NO sur Polymarket
4. Calculer edge:
   - edge_yes = fair_yes - ask_yes
   - edge_no = fair_no - ask_no
5. Si edge > seuil (ex: 5¢):
   - Acheter le côté sous-pricé
6. Tracker position pour maintenir pair_cost < 0.98
7. Stop si profit locké OU time < 30 sec
```

---

### Paramètres MVP

| Param | Valeur initiale |
|-------|-----------------|
| σ (vol annualisée) | 0.60 (60%) |
| Edge minimum | 0.05 (5¢) |
| Max position par côté | $500 |
| Ratio max YES/NO | 1.5 |
| Stop avant fin | 30 sec |
| Max shares par ordre | 10 |
| Max shares par market (YES+NO) | 100 |

---

### Event-driven (WebSocket)
```
on binance_ws.price_update(btc):
  fair_yes, fair_no = calc_fair(btc, strike, time_left)
  check_and_trade(fair_yes, fair_no)

on polymarket_ws.orderbook_update(book):
  check_and_trade(fair_yes, fair_no)

check_and_trade(fair_yes, fair_no):
  if (fair_yes - poly.ask_yes) > 0.05:
    buy YES (max 10 shares)
  
  if (fair_no - poly.ask_no) > 0.05:
    buy NO (max 10 shares)
  
  log(position, pair_cost, pnl)
```

---

### Output attendu
```
[10:14:32] BTC=92651 | fair=0.72 | ask_yes=0.65 | EDGE=+7¢ | BUY YES
[10:14:33] BTC=92620 | fair=0.68 | ask_yes=0.67 | edge=+1¢ | skip
[10:14:58] BTC=92510 | fair=0.52 | ask_no=0.38  | EDGE=+10¢ | BUY NO
[10:15:00] RESOLVED UP | PnL=+$X

Risques

Vol mal calibrée → fair value fausse
Slippage → book thin
Chainlink ≠ Binance → settlement suit Chainlink
Latence → edge disparaît si trop lent


Next steps

Connecter Binance WS
Connecter Polymarket API
Implémenter calc_fair_value()
Backtest sur marchés passés
Paper trade
Live petit size
