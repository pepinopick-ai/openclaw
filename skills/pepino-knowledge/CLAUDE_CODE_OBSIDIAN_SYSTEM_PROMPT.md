# CLAUDE_CODE_OBSIDIAN_SYSTEM_PROMPT.md

# Pepino Pick — Pravila raboty Claude Code s Obsidian vault

# Version: 2.0 | 2026-03-19

---

## ROL OBSIDIAN V SISTEME

Obsidian — eto KNOWLEDGE LAYER, ne operacionnyj SSOT.
Operacionnyj SSOT = Google Sheets (`1AB9nkHfCu8_12dwn72tWKZOiqHAfAhI3AHOjeAAByoc`).

Obsidian xranit: POCHEMU, CHTO UZNAL, KAK DELAT, KTO eto.
Sheets xranit: KAKOJ STATUS, KAKIE CHISLA, KAKIE TRANZAKCII.

---

## KOGDA ISPOLZOVAT OBSIDIAN

Chitat iz Obsidian:

- Pered otvetom na vopros ob arxitekture sistemy
- Kogda nuzhen kontekst dlya case_id (sm. 02_cases_context)
- Pri podgotovke ezhenedelnogo obzora (sm. 01_dashboard_notes)
- Dlya prosmotra SOP indeksov (sm. 04_sops_index)
- Dlya prosmotra urokovi i playbooks

PISAT v Obsidian (cherez pepino-knowledge):

- Posle incidenta urovnya RED → 07_postmortems/
- Pri zapis novogo resheniya → 03_decision_memos/
- Posle batch s anomaliej → 06_lessons_learned/
- Pri novom profile lica → 11_people/
- Sobytiya iz OSINT → 11_people/osint/

---

## STRUKTURA VAULT

Vse papki i ix naznachenie:

| Papka              | Tip zapicej                  | Shema nazvaniya              |
| ------------------ | ---------------------------- | ---------------------------- |
| 00_inbox           | Vxodyaschie (< 48h)          | lyuboe                       |
| 01_dashboard_notes | CEO flash notes, weekly prep | YYYY-MM-DD-tema.md           |
| 02_cases_context   | Kontekst dlya case_id        | CASE-YYYYMMDD-XXX-context.md |
| 03_decision_memos  | Arxiv reshenij               | DEC-YYYYMMDD-tema.md         |
| 04_sops_index      | Navigaciya SOPov             | SOP-KOD-nazvanie.md          |
| 05_playbooks       | Takticheskie scenarii        | PB-tema.md                   |
| 06_lessons_learned | Uroki iz opyta               | LL-YYYYMMDD-tema.md          |
| 07_postmortems     | Razbor oshibok               | PM-YYYYMMDD-incident.md      |
| 08_training        | Obuchenie komandy            | lyuboe                       |
| 09_architecture_ai | AI sistema                   | lyuboe                       |
| 10_projects        | RD proekty                   | PROJ-nazvanie.md             |
| 11_people          | Profili lyudej               | Familiya-Imya.md             |
| 12_market_intel    | Rynok, trendy                | MI-YYYYMMDD-tema.md          |
| 99_archive         | Arxiv                        | sohranyat strukturu          |
| Templates          | Shablony Templater           | Template-\*.md               |

---

## OBYAZATELNYJ FRONTMATTER

Kazhdaya zapiska DOLZHNA imet:

```yaml
---
id: [type]-YYYYMMDD-[slug]           # primer: LL-20260319-mushroom-contamination
title: "Chelovekochitaemyj zagolovok"
type: lesson                          # sm. spisok tipov nizhe
status: draft                         # draft | active | superseded | archived
owner: roman
created_at: 2026-03-19
updated_at: 2026-03-19
linked_cases: []                      # [CASE-20260319-AGR]
linked_entities: []                   # [Chef Mario, Proveedor ABC]
linked_sops: []                       # [SOP-AGR-001]
linked_agents: []                     # [pepino-fermentation]
tags: []
confidentiality: internal             # internal | restricted | confidential
---
```

Tipy (type):

- lesson — urok iz opyta
- decision — arxiv resheniya
- postmortem — razbor oshibki
- sop — SOP indeks
- playbook — takticheskie scenario
- training — obuchayuschij material
- architecture — AI arxitektura
- project — RD proekt
- person — profil lica
- market_intel — rynochnyj analiz
- weekly_review — ezhenedelnyj obzor
- case_context — kontekst dlya case_id
- inbox — vxodyaschaya zapiska

---

## PRAVILA ZAPISI

1. NIKOGDA ne zapisyvay v Obsidian:
   - Tekuschij status kejsa (→ Sheets/Zadachi)
   - Apruvy (→ Sheets/Alerdy)
   - Plateji i tranzakcii (→ Sheets/Finansy)
   - Istochniki KPI (→ Sheets/Dashboard)
   - Ostanki zapasov (→ Sheets/Logistika)
   - Batch status (→ Sheets/Agronomiya)

2. Pri sozdanii zametki:
   - Vsegda validiruy frontmatter pered sozdaniem
   - Ukazyvay linked_cases dlya trassiruyemosti
   - Ne periezapisyvay suschestvuyuschie zametki bez voprosa
   - Ispolzuj shablony iz Templates/

3. Kross-ssylki Obsidian ↔ Sheets:
   - V zametke: linked_cases: [CASE-20260319-AGR]
   - V Sheets/Zadachi: stolbec "obsidian_note" so ssylkoj

---

## SHABLONY POSTMORTEM

Struktura 07_postmortems/PM-\*.md:

```markdown
## Chto proizoshlo

[Kratkoe opisanie incidenta]

## Root Cause

[Kornevaya prichina]

## Impact

[Vliyanie na biznes: finansy, reputaciya, kachestvo]

## Fix Applied

[Chto bylo sdelano dlya ustroneniya]

## Prevention

[Kak predotvratit v buduschem]

## Timeline

- HH:MM — sobytie 1
- HH:MM — sobytie 2
```

---

## INTEGRACIYA S AGENTAMI

Kogda agent pepino-dispatcher sozdaet novyj case:

1. Zapisat operacionnyj status v Sheets/Zadachi
2. OPCJONALNO: sozdat 02_cases_context/CASE-xxx-context.md esli est dopolnitelnyj kontekst

Kogda agent pepino-fermentation zavershaet batch s anomaliej:

1. Obnovit Sheets/Agronomiya
2. AVTO: sozdat 06_lessons_learned/LL-[date]-[batch].md

Kogda pepino-qa-food-safety fiksiruet incident RED:

1. Zapisat v Sheets/Alerdy
2. AVTO: sozdat 07_postmortems/PM-[date]-[incident].md

Kogda pepino-dispatcher apruvaet reshenie DEC:

1. Zapisat v Sheets/Resheniya
2. AVTO: sozdat 03_decision_memos/DEC-[date]-[topic].md

---

## VAULT PATHS

Server: /home/roman/pepino-obsidian/
Windows: C:\Users\Roman\pepino-obsidian\
GitHub: https://github.com/pepinopick-ai/pepino-obsidian
Sync: Obsidian Git plugin (auto-commit 30 min)
