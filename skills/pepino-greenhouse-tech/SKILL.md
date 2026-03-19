---
name: pepino-greenhouse-tech
description: "Inzhenernye raschety teplicy — osveschenie PPFD/DLI, HVAC/CO2, irrigaciya, energoaudit. Avto-vyzyvaj pri slovax: PPFD, DLI, osveschenie, LED, HVAC, CO2, otoplenie, ventilyaciya, poliv, energoaudit, tochka rosy, nasos."
homepage: https://pepino.pick
metadata:
  openclaw:
    emoji: "🔬"
    requires:
      bins: []
---

# Pepino Greenhouse Tech — Inzhenernye Raschety

Raschety osvescheniya, mikroklimata, irrigacii, energopotrebleniya.

## 4 rezhima

### Rezhim 1 — Osveschenie (PPFD/DLI)

Formuly:
DLI = PPFD x fotoperiod (chasy) x 3600 / 1000000
PPFD_trebuemyj = DLI_target / (fotoperiod x 3.6)

Targety DLI po kulturam:
| Kultura | DLI target (mol/m2/d) | Fotoperiod |
|---|---|---|
| Ogurcy | 20-30 | 16-18h |
| Veshenka | 2-5 | 12h |
| Shiitake | 1-3 | 12h |
| Mikrozelen | 10-16 | 16h |
| Tsitsak | 18-25 | 16h |

Raschet kolichestva lamp:
N_lamp = (PPFD_target x Ploshadj_m2) / Svetovoj_potok_lampy

Komanda:
Rasschetaj PPFD dlya Zone-A: 120m2, cel DLI 25, fotoperiod 16h
Skolko lamp LED 640 Vt nado dlya Zone-C 30m2, PPFD 250?

### Rezhim 2 — HVAC, CO2, mikroklimat

Teplopoteri (prostoj raschet):
Q = U-faktor x Ploshadj x (Tvnutri - Tnaruzhi)
U-faktor teplicy (polikarbonat 16mm): 1.8-2.5 W/m2K
U-faktor steklo: 2.8-3.0 W/m2K

Psixrometriya:
Tochka rosy = T - (100 - RH) / 5 (priblizitelno)
Kondensaciya esli Tpoverhnosti < Tochki rosy

CO2 enrichment:
Target: 800-1200 ppm (ambientnyj: 420 ppm)
Prirост urozhaya: +20-30% pri CO2 1000 ppm
Rashod CO2: ~1-2 kg/h na 100m2 pri gerchetichnosti

Ventilyaciya:
Kratnost vozduhoobmena: 30-60 raz/chas (dlya teplicy)
V_ventilyatora = Ob_em_teplicy x Kratnost / 60

Komanda:
Rasschetaj teplopoteri Zone-A: 200m2, U=2.0, inside 24C, outside -5C
Tochka rosy pri temp 22C i vlazhnosti 85%?
Skolko CO2 v chas nuzhno dlya teplicy 500m3?

### Rezhim 3 — Irrigaciya i pitatelnyj rastvor

Gidroponicheskie raschety:
EC_target: 2.0-3.5 mS/cm dlya ogurcev
Rashod vody: 1-3 L/m2/sutki (gidroponika)
Ob_em_bakа_min = Rashod_vody x Ploshadj x Zapas_dnej

Pompa:
Davlenie = Vysota_podacha (m) x 0.1 (bar) + Poteri_trenie
Proizvoditelnost pompy >= Rashod_vody x Ploshadj / Vremya_poliva

Dripline raschety:
Kolichestvo kapelnic = Ploshadj / Rashod_kapelnicy x Koef
Davlenie dripline: 1.0-2.5 bar

Komanda:
Rasschetaj ob_em baka dlya Zone-A 100m2, 3L/m2/den, zapas 3 dnya
Kakuyu pompu podobrat dlya podachi vody na vysotu 4m, 500m2?

### Rezhim 4 — Energoaudit

Raschet energopotrebleniya:
LED lampy: Kolichestvo x Moschnost_Vt / 1000 = kVt
Klivcheskie nagruzki: LED + Nasosy + Ventilyaciya + Otoplenie
Sutochnoe: Sum(kVt x Chasy_raboty)
Mesyachnoe: Sutochnoe x 30

Cost analysis:
Stoimost_kVth = [tarifARS] ARS/kVth
Rashod_ARS_mesyac = kVth_mesyac x Tarit
ROI_LED = (Ekonomiya_vs_HPS x 12) / Stoimost_investicij

Komanda:
Energoaudit teplicy: 80 lamp LED 640Vt 16h/d, 3 nasosy 1.5kVt 4h/d
ROI zameny HPS na LED: 60 lamp HPS 1000Vt -> LED 640Vt, cena LED 45000 ARS
Mesyachnyj rashod na elektrichestvo pri tarite 150 ARS/kVth

## Integracii

- pepino-agro-ops — energoaudit + parametry osvescheniya v zhurnal
- pepino-controller — energozatraty v P&L
- pepino-weekly-review — tehnicheskie KPI v digest

## Primery komand

```
Rasschetaj DLI Zone-A: PPFD 280, fotoperiod 16h
Skolko svetodiodn. lamp dlya 120m2 pri PPFD 250?
Teplopoteri pri -10C snaruzhi i +22C vnutri, 300m2 polikarbonat
Tochka rosy: temp 20C, vlazhnost 90%
Energopotreblenie: 60 lamp 640Vt po 16h + 4 nasosy 1.5kVt 6h
Ob_em baka: 80m2, poliv 2L/m2/den, zapas 5 dnej
```
