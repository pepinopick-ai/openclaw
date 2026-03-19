---
name: pepino-agro-ops
description: Agronomiya Pepino Pick
homepage: https://pepino.pick
metadata:
  openclaw:
    emoji: seedling
    requires:
      bins: []
---

# Pepino Agro-Ops

Zony: Zone-A=Ogurcy, Zone-B=Griby, Zone-C=Mikrozelen+Tsitsak
Sheets ID: 1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc

## Tselevye parametry

| Kultura    | EC      | pH      | Temp   | Vlazhnost |
| ---------- | ------- | ------- | ------ | --------- |
| Ogurcy     | 2.0-3.5 | 5.8-6.5 | 20-28C | 70-85%    |
| Veshenka   | N/A     | 6.0-7.0 | 16-24C | 85-95%    |
| Shiitake   | N/A     | 5.5-6.5 | 15-21C | 80-90%    |
| Mikrozelen | 1.2-2.0 | 5.5-6.5 | 18-24C | 50-70%    |
| Tsitsak    | 2.5-4.0 | 5.8-6.5 | 22-30C | 60-75%    |

## 5 rezhimov

### Rezhim 1 — Dnevnoj zhurnal

Shablon proverki:

```
DENNAYA PROVERKA — [data]
Zone-A (Ogurcy):
  EC: [X] TARGET: 2.0-3.5 [OK/ALERT]
  pH: [X] TARGET: 5.8-6.5 [OK/ALERT]
  Temp: [X]C  TARGET: 20-28 [OK/ALERT]
  Vlazhnost: [X]%  TARGET: 70-85 [OK/ALERT]
  Osmotr: [norma/zheltenie/pyatna/uvyadanie/plesenj]
  Dejstvie: [chto sdelano]

Zone-B (Griby):
  Temp: [X]C, Vlazhnost: [X]%
  Blokov aktivnyx: [N]
  Primordia: [da/net]
  Osmotr: [norma/konkurentnyj grib]

Zone-C (Mikrozelen+Tsitsak):
  EC: [X], pH: [X]
  Podnosov: [N]
  Tsitsak stadiya: [vegetaciya/cvetenie/plodonosenie]
```

ALERT pri vyhode -> Sheets/Alerdy:

```
Data | Agronomicheskij | Zone-X | pepino-agro-ops | opisanie | prioritet | otkryt
```

### Rezhim 2 — Rannee obnaruzheniye boleznej

| Simptom                | Prichina              | Prioritet | Dejstvie                         |
| ---------------------- | --------------------- | --------- | -------------------------------- |
| Zhyoltye listya (nizh) | Deficit N / starenie  | WARN      | Proverit EC, +N                  |
| Korichnevye pyatna     | Botrytis / Alternaria | CRIT      | Snizit vlazhnost, fungicid       |
| Belyj nalet            | Muchnistaya rosa      | CRIT      | Ventilyaciya, sernyjsprey        |
| Uvyadanie dnem         | Voda / Fusarium       | CRIT      | Proverit poliv+substrat          |
| Plesenj na blokax      | Konkuriruyuschij grib | CRIT      | Izolirovaty, proverit sterilnost |
| Zhyoltye kolca         | Virusnaya infekciya   | CRIT      | Karantin, udalit rastenie        |

ALERT sistema:

- 1 simptom -> nablyudat, zapisyvat
- 2+ symptoma ili 20%+ porazheniya -> ALERT v Sheets
- Rasprostranenie 2+ zony -> KRITICHESKIJ ALERT

### Rezhim 3 — Planirovschik posevov

Cikly vyrashchivaniya:
| Kultura | Posev-Sbor | Primechanie |
|---|---|---|
| Ogurcy | 45-60 dnej | Gidroponika, 2 cikla/kvartal |
| Veshenka | 30-45 dnej | Posle inokulacii bloka |
| Shiitake | 60-90 dnej | Trebuet stimulyacii |
| Mikrozelen | 7-14 dnej | 4+ cikla/mesyac |
| Tsitsak | 90-120 dnej | Mnogoletnik |

Shablon mesyachnogo plana:

```
PLAN POSEVOV — [mesyac god]
Nedelya 1: [kultura] [X] sht, Zone-[X]
Nedelya 2: sborovki + novye posevki
Prognoz urozhaya mesyaca:
  Ogurcy: ~[X] kg
  Veshenka: ~[X] kg
  Shiitake: ~[X] kg
  Mikrozelen: ~[X] kg
ITOGO: ~[X] kg
```

Zapis poseva v Sheets/Agronomiya:

```
Data | Kultura | batch_id | Posev | kol-vo | EC | pH | Zone-X | Plan sbora: [data]
```

### Rezhim 4 — Urozhajnost po zonam

Shablon ezhenedelnogo otcheta:

```
UROZHAJNOST — [period]
Zone-A Ogurcy:
  Fakt: [X] kg  Target: [X] kg  Raznitsa: [+/-X]% [OK/NIZHE NORMY]
Zone-B Griby:
  Veshenka: [X] kg ([N] blokov, [X] kg/blok)
  Shiitake: [X] kg ([N] blokov, [X] kg/blok)
Zone-C:
  Mikrozelen: [X] kg ([N] podnosov)
  Tsitsak: [X] kg
ITOGO: [X] kg  vs proshlaya nedelya: [+/-X]%
```

### Rezhim 5 — Texnicheskoe obsluzhivanie

Ezhednevno: proverka drenazha, vizualnyj osmotr
Ezhenedelno: kalibraciya EC/pH, ochistka filtrov
Ezhemesyachno: zamena rastvora, proverka nasosov, dezinfekciya Zone-B
Ezhekvartalijno: zamena lamp, audit orosheniya

Shablon TO:

```
TO — [data] [tip]
Zona: [A/B/C/Vse]
Vypolneno: [spisok rabot]
Najdeno: [problemy ili norma]
Sleduyuschee TO: [data]
```

Zapis v Sheets/Zadachi:

```
Data | TO-[tip] | Agronomiya | [otvetstvennyj] | [prioritet] | [dedlajn] | status
```

## KPI agronomii

```
AGRONOMIYA KPI
  Urozhajnost ogurcev: [X] kg/m2 (target: [Y])
  Effektivnost blokov: [X] kg/blok (target: [Y])
  Mikrozelen/nedelyu: [N] podnosov
  Otxodnost: [X]% tovarnoj produkcii
  Aktivnyx ALERT: [N]
  Sleduyuschij posev: [data]
```

## Integracii

- pepino-google-sheets — Agronomiya / Alerdy / Zadachi
- pepino-qa-food-safety — peredacha batch_id
- pepino-fermentation — otxody -> fermentaciya (waste-to-value)
- pepino-controller — urozhajnost v P&L
- pepino-weekly-review — dannye v ezhenedelnyj dajdzhest
- pepino-agro-cucumber-photos — foto diagnostika ogurca

## Primery komand

```
Dnevnaya proverka: Zone-A EC 3.2, pH 6.1, temp 24, vlazhnost 78
U shiitake blokov belyj nalet — chto delat?
Sostavit plan posevov na aprel
Otchet urozhajnosti za proshluyu nedelyu
Vnesti v grafik: kalibraciya EC v pyatnitsu
Kakie bloki shiitake gotovy k sboru?
Zapisat sbor: Zone-A ogurcy 45 kg, batch BATCH-20260319-001
```
