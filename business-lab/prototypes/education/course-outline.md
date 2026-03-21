# Mini-Course: "AI Agent za 7 dney"

## Target Audience

- Small business owners who want automation but can't afford enterprise tools
- Developers who want to learn AI agent patterns
- Entrepreneurs building AI-powered services

## Prerequisites

- Basic computer skills
- Google account (for Sheets)
- $0 budget (everything is free tools)

## Day 1: What is an AI Agent OS?

**Goal:** Understand the architecture

- What agents do (read data -> think -> act)
- Architecture: Data Layer + Logic Layer + Action Layer
- Real example: Pepino Pick morning briefing
  - 06:00: reads production, sales, inventory
  - 06:05: analyzes gaps, predicts demand
  - 06:10: sends action plan to Telegram
- Your homework: Draw your business processes on paper

## Day 2: Google Sheets as Your Database

**Goal:** Set up data layer

- Why Sheets > Supabase/Firebase for SMBs
  - Free, no devops, your team already knows it
  - API included, real-time, collaborative
- Setting up Google Sheets API (service account)
- Reading data with Node.js
- Writing data (logging sales, inventory)
- Template: Business data structure (5 sheets)
- Your homework: Create your business spreadsheet

## Day 3: Your First Automation Script

**Goal:** Write code that reads data and makes decisions

- Node.js basics (just enough)
- Reading from Sheets API
- Simple business logic:
  ```
  IF stock < 3_days -> alert
  IF client_inactive > 14_days -> follow_up
  IF margin < 35% -> price_review
  ```
- Running on schedule (cron basics)
- Your homework: Write 1 rule for your business

## Day 4: Telegram Bot Integration

**Goal:** Add communication layer

- Creating a Telegram bot (5 minutes)
- Sending messages from your script
- Formatting: HTML, buttons, threads
- Receiving commands (interactive bot)
- Your homework: Bot sends you daily summary

## Day 5: Scheduled Jobs & Monitoring

**Goal:** Make it run 24/7

- Cron scheduling (when to run what)
- Error handling (don't crash silently)
- Self-healing basics (restart on failure)
- Logging (know what happened)
- Your homework: 3 cron jobs running

## Day 6: AI Integration

**Goal:** Add intelligence

- Claude/GPT API basics
- Prompt engineering for business
- Examples:
  - Classify customer messages
  - Generate sales reports
  - Predict demand from history
- Cost management ($0.01 per query with Haiku)
- Your homework: AI analyzes your data

## Day 7: Full System

**Goal:** Everything connected

- Architecture review: your complete agent
- Pipeline pattern (morning -> analysis -> alerts -> actions)
- Scaling: adding more agents
- What's next: Digital Twin, Knowledge Layer, Task Brain
- Your homework: Share your system on Twitter!

## Bonus Materials

- All code templates (GitHub repo)
- Pepino Pick sanitized scripts (10 key scripts)
- Google Sheets templates (5 business types)
- Telegram bot template
- Cron job template
- Checklist: "Is my AI Agent production-ready?"
