---
name: pepino-financial-modeling
description: "Finansovoe modelirovanie Pepino Pick — scenarnyj analiz P&L, proekciyi vyruchki, sezonnoe planirovanie, break-even, ROI po produktam, DCF. Avto-vyzyvaj pri slovax: prognoz, scenarij, finansovaya model, proekcia, brek-even, okupaemost, ROI, investicii, cash flow prognoz, budget, plan vyruchki."
homepage: https://pepino.pick
metadata:
  openclaw:
    emoji: "📈"
    requires:
      bins: []
---

# Pepino Financial Modeling — Finansovoe Modelirovanie

Scenariyi P&L, proekciyi, break-even, ROI, sezonnost.

Sheets ID: 1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc

- Finansy — istoricheskie dannye
- Dashboard — KPI i proekciyi
- Strategiya — scenariyi razvitiya

## 4 rezhima

### Rezhim 1 — Scenarnyj analiz P&L

Tri scenariya (base/bull/bear):

```
SCENARIJ P&L — [period]
  | Metrika | Bear | Base | Bull |
  |---|---|---|---|
  | Vyruchka ARS/mes | [X] | [Y] | [Z] |
  | Valovaya marzha % | [X] | [Y] | [Z] |
  | EBITDA % | [X] | [Y] | [Z] |
  | Cash flow | [X] | [Y] | [Z] |

Dopuscheniya Bear: inflyaciya +10%/mes, prodazhi -20% vs plan
Dopuscheniya Base: inflyaciya +5%/mes, prodazhi = plan
Dopuscheniya Bull: novye klienty +3/mes, product mix sdvig k premium
```

Inflyacionnaya korrekciya:
Realnyj rost = (1 + Nominalnyj rost) / (1 + Inflyaciya) - 1

### Rezhim 2 — Proekciyi vyruchki

12-mesyachnyj prognoz:

```
PROGNOZ VYRUCHKI — [god]
Mes | Klienty | Srednij cek ARS | Vyruchka ARS | USD ekvivalent
[mesyac] | [N] | [X] | [Y] | [Z]
...
ITOGO: [X] ARS  /  [X] USD
```

Sezonnost Pepino Pick:

- Leto (dic-feb): maksimum ogurcy +20%, griby -10%
- Osen (mar-may): rost na griby +30%
- Zima (jun-ago): maksimum griby + fermentaciya
- Vesna (sep-nov): rost mikrozelen, Tsitsak

Komanda:
Prognoz vyruchki na 6 mes: tekuschie 8 klientov, target +2/mes, srednij cek 65000 ARS

### Rezhim 3 — Break-even i ROI

Break-even raschet:
BEP_units = Postoyannye_zatraty / (Cena_ediniczy - Perehmennye_zatraty_ediniczy)
BEP_vyruchka = Postoyannye_zatraty / (1 - Perehmennye/Vyruchka)

ROI po produktam:

```
ROI ANALIZ — [produkt]
  Investicii: [X] ARS (oborudovanie + substrat + trud)
  Vyruchka za cikl: [X] ARS
  Sebe_stoimost cikla: [X] ARS
  Pribyl cikla: [X] ARS
  Ciklov v god: [N]
  Godovoj ROI: [X]%
  Srok okupemosti: [N] mes
```

DCF (Discounted Cash Flow) - uproschennyj:
NPV = Sum(CF_t / (1+r)^t) - Investicii
r = stavka diskontirovamiya (ARS = 20-30%/god, USD = 8-12%/god)

Komanda:
Break-even po shiitake: postoyannye zatraty 50000 ARS/mes, cena 3500 ARS/kg, CV 1800 ARS/kg
ROI novoj linii gribnogo produkcii: investicii 500000 ARS, pribyl 45000 ARS/mes

### Rezhim 4 — Godovoj byudzhet i monitoring

Struktura godovogo byudzheta:

```
BYUDZHET [god]
  DOKHODY
    Ogurcy sviezhie: [X] kg x [Y] ARS = [Z] ARS
    Griby (veshenka + shiitake): [X] kg x [Y] ARS = [Z] ARS
    Fermentaciya: [X] ARS
    Mikrozelen: [X] ARS
  ITOGO DOKHODY: [X] ARS/god

  RASKHODY
    Zakupki (substrat, michelij, semena): [X] ARS
    Elektrichestvo: [X] ARS
    Trud: [X] ARS
    Dostavka: [X] ARS
    Arenda/ipoteka: [X] ARS
    Prochee: [X] ARS
  ITOGO RASKHODY: [X] ARS/god

  EBITDA: [X] ARS  ([X]%)
  EBITDA target: >30%
```

Budget vs Fact monitoring (ezhmesyachno):
Otklonenie > 10% -> WARN v Sheets/Alerdy
Otklonenie > 20% -> CRIT, scenarij pererascheta

## KPI finansovogo modelirovaniya

```
FIN MODEL KPI
  Mesyachnyj Revenue target: [X] ARS
  Gross Margin target: >50%
  EBITDA target: >30%
  Cash runway: >3 mes
  BEP: [X] ARS/mes
  Tekuschij ROI portfelya: [X]%
```

## Integracii

- pepino-controller — fakticheskie dannye dlya sravneniya
- pepino-argentina-finance — kurs ARS/USD dlya USD-proekzij
- pepino-finance-tools — NPV/DCF raschety
- pepino-weekly-review — prognoz v ezhenedelnyj digest

## Primery komand

```
Scenarij P&L na Q2: base + bull + bear
Prognoz vyruchki na 12 mes pri tekuschej baze klientov
Break-even teplicy pri tekuschikh rasxodakh
ROI linii fermentacii: investicii 800000 ARS
Godovoj byudzhet 2026: plan vyruchki 4.5M ARS
Kak izmenyatsya pokazateli esli dobavit 3 novyx restoran-klienta?
```
