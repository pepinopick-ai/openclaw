---
name: youtube-manager
description: Полный менеджер YouTube канала — аналитика, публикация видео, управление метаданными, SEO, продвижение, экспорт в Google Sheets. Авто-вызывай при словах "youtube", "ютуб", "канал", "видео опубликовать", "статистика канала", "загрузить видео", "комментарии ютуб", "SEO видео".
homepage: https://developers.google.com/youtube/v3
metadata: { "openclaw": { "emoji": "▶️", "requires": { "bins": [] } } }
---

# YouTube Manager

## Настройка (первый раз)

### Шаг 1 — Google Cloud проект

1. Открой https://console.cloud.google.com
2. Создай новый проект (или выбери существующий)
3. В меню слева: **APIs & Services → Library**
4. Найди **YouTube Data API v3** → Enable

### Шаг 2 — API ключ (только для чтения/аналитики)

1. **APIs & Services → Credentials → Create Credentials → API key**
2. Скопируй ключ
3. Сохрани: `export YOUTUBE_API_KEY="твой_ключ"`

### Шаг 3 — OAuth2 (для загрузки и управления видео)

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Desktop app**
3. Скопируй `Client ID` и `Client Secret`
4. Сохрани:

```bash
export YOUTUBE_CLIENT_ID="твой_client_id"
export YOUTUBE_CLIENT_SECRET="твой_client_secret"
```

5. Получи refresh_token (одноразово):

```bash
# Открой эту ссылку в браузере (замени CLIENT_ID):
https://accounts.google.com/o/oauth2/auth?client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/youtube&response_type=code&access_type=offline

# После авторизации получишь code, обменяй его на токены:
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=КОД_ИЗ_БРАУЗЕРА" \
  -d "client_id=$YOUTUBE_CLIENT_ID" \
  -d "client_secret=$YOUTUBE_CLIENT_SECRET" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob" \
  -d "grant_type=authorization_code" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('refresh_token:', d.get('refresh_token','НЕТ - попробуй снова с ?prompt=consent'))
"
```

6. `export YOUTUBE_REFRESH_TOKEN="твой_refresh_token"`

### Вспомогательная функция — получить access_token

```bash
yt_token() {
  curl -s -X POST https://oauth2.googleapis.com/token \
    -d "client_id=$YOUTUBE_CLIENT_ID" \
    -d "client_secret=$YOUTUBE_CLIENT_SECRET" \
    -d "refresh_token=$YOUTUBE_REFRESH_TOKEN" \
    -d "grant_type=refresh_token" | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])"
}
```

---

## /youtube-manager analyze

Статистика канала — подписчики, просмотры, количество видео.

```bash
curl -s "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true" \
  -H "Authorization: Bearer $(yt_token)" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
ch = d['items'][0]
s = ch['statistics']
print(f'Канал:        {ch[\"snippet\"][\"title\"]}')
print(f'Подписчики:   {int(s.get(\"subscriberCount\",0)):,}')
print(f'Просмотры:    {int(s.get(\"viewCount\",0)):,}')
print(f'Видео:        {s.get(\"videoCount\",0)}')
print(f'ID канала:    {ch[\"id\"]}')
"
```

## /youtube-manager videos [количество]

Список видео канала с метриками просмотров и лайков.

```bash
LIMIT="${1:-20}"
# Сначала получаем ID канала
CHANNEL_ID=$(curl -s "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true" \
  -H "Authorization: Bearer $(yt_token)" | python3 -c "import json,sys; print(json.load(sys.stdin)['items'][0]['id'])")

# Поиск видео канала
curl -s "https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=$CHANNEL_ID&type=video&order=date&maxResults=$LIMIT" \
  -H "Authorization: Bearer $(yt_token)" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'{'Название':<50} {'ID видео':>13}  {'Дата':>10}')
print('-'*80)
for i in d.get('items', []):
    s = i['snippet']
    vid = i['id']['videoId']
    date = s['publishedAt'][:10]
    print(f'{s[\"title\"][:49]:<50} {vid:>13}  {date:>10}')
"
```

## /youtube-manager stats [VIDEO_ID]

Детальная статистика конкретного видео.

```bash
curl -s "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status&id=VIDEO_ID" \
  -H "Authorization: Bearer $(yt_token)" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
v = d['items'][0]
s = v['statistics']
sn = v['snippet']
st = v['status']
print(f'Название:     {sn[\"title\"]}')
print(f'Статус:       {st[\"privacyStatus\"]}')
print(f'Просмотры:    {int(s.get(\"viewCount\",0)):,}')
print(f'Лайки:        {int(s.get(\"likeCount\",0)):,}')
print(f'Комментарии:  {int(s.get(\"commentCount\",0)):,}')
print(f'Опубликовано: {sn[\"publishedAt\"][:10]}')
print(f'\nОписание:\n{sn[\"description\"][:300]}')
"
```

## /youtube-manager upload [файл] [заголовок] [описание]

Загрузка нового видео (статус: private по умолчанию).

```bash
FILE="путь/к/видео.mp4"
TITLE="Заголовок видео"
DESCRIPTION="Описание видео"
TAGS="тег1,тег2,тег3"

python3 -c "
import json
meta = {
  'snippet': {
    'title': '$TITLE',
    'description': '$DESCRIPTION',
    'tags': '$TAGS'.split(','),
    'categoryId': '22'  # 22 = People & Blogs, 28 = Science & Technology
  },
  'status': {'privacyStatus': 'private'}  # private → unlisted → public
}
print(json.dumps(meta))
" > /tmp/yt_meta.json

curl -s -X POST \
  "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart" \
  -H "Authorization: Bearer $(yt_token)" \
  -F "metadata=</tmp/yt_meta.json;type=application/json" \
  -F "video=@$FILE;type=video/mp4" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Загружено! ID: {d[\"id\"]}')
print(f'URL: https://youtube.com/watch?v={d[\"id\"]}')
print(f'Статус: {d[\"status\"][\"uploadStatus\"]}')
"
```

## /youtube-manager update [VIDEO_ID] [заголовок] [описание] [теги]

Обновление метаданных существующего видео.

```bash
VIDEO_ID="ID_видео"
NEW_TITLE="Новый заголовок"
NEW_DESC="Новое описание"
NEW_TAGS="тег1,тег2"

python3 -c "
import json
body = {
  'id': '$VIDEO_ID',
  'snippet': {
    'title': '$NEW_TITLE',
    'description': '$NEW_DESC',
    'tags': '$NEW_TAGS'.split(','),
    'categoryId': '22'
  }
}
print(json.dumps(body))
" > /tmp/yt_update.json

curl -s -X PUT \
  "https://www.googleapis.com/youtube/v3/videos?part=snippet" \
  -H "Authorization: Bearer $(yt_token)" \
  -H "Content-Type: application/json" \
  -d @/tmp/yt_update.json | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Обновлено: {d[\"snippet\"][\"title\"]}')
"
```

## /youtube-manager schedule [VIDEO_ID] [дата ISO]

Планирование публикации (перевести из private в scheduled).

```bash
VIDEO_ID="ID_видео"
PUBLISH_AT="2026-04-01T12:00:00Z"  # UTC формат

curl -s -X PUT \
  "https://www.googleapis.com/youtube/v3/videos?part=status" \
  -H "Authorization: Bearer $(yt_token)" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"$VIDEO_ID\",
    \"status\": {
      \"privacyStatus\": \"private\",
      \"publishAt\": \"$PUBLISH_AT\"
    }
  }" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Запланировано на: {d[\"status\"].get(\"publishAt\",\"?\")}')
"
```

## /youtube-manager comments [VIDEO_ID] [количество]

Просмотр последних комментариев к видео.

```bash
VIDEO_ID="ID_видео"
LIMIT="${2:-20}"

curl -s "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=$VIDEO_ID&maxResults=$LIMIT&order=time" \
  -H "Authorization: Bearer $(yt_token)" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Комментарии ({d[\"pageInfo\"][\"totalResults\"]} всего):\n')
for item in d.get('items', []):
    c = item['snippet']['topLevelComment']['snippet']
    author = c['authorDisplayName']
    text = c['textDisplay'][:100]
    likes = c.get('likeCount', 0)
    date = c['publishedAt'][:10]
    print(f'[{date}] {author} (👍{likes})')
    print(f'  {text}')
    print()
"
```

## /youtube-manager reply [COMMENT_ID] [текст]

Ответ на комментарий.

```bash
COMMENT_ID="ID_комментария"
REPLY_TEXT="Спасибо за комментарий!"

curl -s -X POST \
  "https://www.googleapis.com/youtube/v3/comments?part=snippet" \
  -H "Authorization: Bearer $(yt_token)" \
  -H "Content-Type: application/json" \
  -d "{
    \"snippet\": {
      \"parentId\": \"$COMMENT_ID\",
      \"textOriginal\": \"$REPLY_TEXT\"
    }
  }" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Ответ опубликован: {d[\"snippet\"][\"textOriginal\"][:80]}')
"
```

## /youtube-manager seo [VIDEO_ID]

Анализ SEO видео — заголовок, описание, теги, рекомендации.

```bash
VIDEO_ID="ID_видео"

curl -s "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=$VIDEO_ID" \
  -H "Authorization: Bearer $(yt_token)" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
v = d['items'][0]
sn = v['snippet']
st = v['statistics']

title = sn['title']
desc = sn['description']
tags = sn.get('tags', [])

print('=== SEO Анализ ===')
print(f'Заголовок ({len(title)} симв.): {title}')
print(f'  ✓ Оптимально: 50-70 символов' if 50<=len(title)<=70 else f'  ⚠ Рекомендуется 50-70 символов (сейчас {len(title)})')

print(f'\nОписание ({len(desc)} симв.):')
print(f'  ✓ Хорошо' if len(desc)>=200 else f'  ⚠ Минимум 200 символов для SEO (сейчас {len(desc)})')

print(f'\nТеги ({len(tags)} шт.): {tags[:5]}')
print(f'  ✓ Хорошо' if 5<=len(tags)<=15 else f'  ⚠ Рекомендуется 5-15 тегов (сейчас {len(tags)})')

ctr_hint = int(st.get('viewCount',0)) / max(1, int(st.get('likeCount',1)))
print(f'\nПросмотры: {int(st.get(\"viewCount\",0)):,} | Лайки: {int(st.get(\"likeCount\",0)):,}')
print(f'Соотношение лайк/просмотр: {100/max(1,ctr_hint):.1f}%')
"
```

## /youtube-manager top [количество]

Топ видео канала по просмотрам.

```bash
LIMIT="${1:-10}"
CHANNEL_ID=$(curl -s "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true" \
  -H "Authorization: Bearer $(yt_token)" | python3 -c "import json,sys; print(json.load(sys.stdin)['items'][0]['id'])")

curl -s "https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=$CHANNEL_ID&type=video&order=viewCount&maxResults=$LIMIT" \
  -H "Authorization: Bearer $(yt_token)" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Топ {len(d[\"items\"])} видео по просмотрам:\n')
for i, item in enumerate(d['items'], 1):
    s = item['snippet']
    vid = item['id']['videoId']
    print(f'{i:2}. {s[\"title\"][:60]}')
    print(f'    ID: {vid} | https://youtube.com/watch?v={vid}')
"
```

## /youtube-manager export-sheets [название таблицы]

Экспорт статистики видео в Google Sheets через MCP.

1. Получи список видео через команду `videos 50`
2. Для каждого видео получи статистику через `stats VIDEO_ID`
3. Сформируй таблицу с колонками: Название | ID | Просмотры | Лайки | Комментарии | Дата | URL
4. Используй Google Sheets MCP для записи данных
5. Добавь строку-заголовок с датой обновления

---

## Категории видео (categoryId)

| ID  | Категория            |
| --- | -------------------- |
| 1   | Film & Animation     |
| 10  | Music                |
| 15  | Pets & Animals       |
| 17  | Sports               |
| 20  | Gaming               |
| 22  | People & Blogs       |
| 23  | Comedy               |
| 24  | Entertainment        |
| 26  | Howto & Style        |
| 27  | Education            |
| 28  | Science & Technology |

## Лимиты YouTube Data API v3

- Бесплатная квота: **10,000 units/день**
- Загрузка видео: 1600 units
- Чтение списка: 1 unit
- Обновление метаданных: 50 units
- Проверь остаток: https://console.cloud.google.com → APIs & Services → YouTube Data API v3

## Сохранение данных между сессиями

```
docs/youtube-data/
├── channel-stats.md    ← история статистики канала
├── video-log.md        ← лог загруженных видео
└── seo-notes.md        ← заметки по SEO и тегам
```
