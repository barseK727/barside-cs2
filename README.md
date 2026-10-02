# BARSIDE CS2

Платформа для поиска тиммейтов и участия в турнирах по Counter-Strike 2.

## Стек
- Backend: Node.js + Express + PostgreSQL
- Frontend: Vanilla JS SPA
- Auth: Steam OpenID
- Платежи: ЮKassa (опционально)

## Установка
1. Установите Node.js 18+ и PostgreSQL 16.
2. Создайте БД: `CREATE DATABASE barside;`
3. В `server/.env` заполните переменные (см. `.env.example`).
4. `cd server && npm install`
5. `npm start`

Сервер: http://localhost:5000

## Переменные окружения (server/.env)