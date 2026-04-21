# 📱 iPhone Store — Backend API

Sistema completo de gestão para lojas de iPhone. API REST segura, com autenticação JWT, validações robustas, geração de PDF e envio de e-mail automático.

---

## 🚀 Início Rápido

### Pré-requisitos
- Node.js ≥ 18
- PostgreSQL ≥ 14
- npm ≥ 9

### Instalação

```bash
# 1. Clone e instale dependências
cd backend
npm install

# 2. Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais

# 3. Crie o banco de dados
createdb iphone_store

# 4. Execute as migrations
npm run migrate

# 5. Popule com dados iniciais
npm run seed

# 6. Inicie o servidor
npm run dev        # desenvolvimento
npm start          # produção
```

---

## 🏗️ Arquitetura

```
backend/
├── src/
│   ├── app.js                   # Entry point do servidor Express
│   ├── config/
│   │   ├── database.js          # Pool PostgreSQL + helpers de query
│   │   └── iphoneModels.js      # Catálogo completo de iPhones
│   ├── controllers/
│   │   ├── authController.js    # Login, registro, refresh token
│   │   ├── clientController.js  # CRUD de clientes
│   │   └── serviceOrderController.js  # Ordens de serviço
│   ├── middleware/
│   │   ├── auth.js              # JWT: authenticate + authorize
│   │   ├── security.js          # Helmet, CORS, rate limit, XSS
│   │   └── validation.js        # Validações com express-validator
│   ├── routes/
│   │   └── index.js             # Definição de todas as rotas
│   ├── services/
│   │   ├── cepService.js        # Integração ViaCEP
│   │   ├── emailService.js      # Envio de e-mail via Nodemailer
│   │   └── pdfService.js        # Geração de PDF com PDFKit
│   └── utils/
│       ├── helpers.js           # CPF, IMEI, formatadores, paginação
│       └── logger.js            # Winston logger
├── database/
│   ├── migrations/
│   │   └── 001_initial.sql      # Schema completo do banco
│   ├── migrate.js               # Runner de migrations
│   └── seed.js                  # Dados iniciais
└── logs/                        # Arquivos de log (gerado em runtime)
```

---

## 🔐 Segurança Implementada

| Camada | Proteção |
|---|---|
| **Helmet** | 12+ headers HTTP seguros (CSP, HSTS, X-Frame-Options…) |
| **Rate Limiting** | 100 req/15min (geral), 10 req/15min (auth) |
| **JWT** | Access token (8h) + Refresh token (7d) |
| **bcrypt** | Hash de senhas com 12 rounds de salt |
| **express-validator** | Validação de todos os inputs |
| **XSS** | Sanitização de todos os campos do body/query |
| **SQL Injection** | Prepared statements em todas as queries |
| **CORS** | Origens explicitamente configuradas |
| **Soft Delete** | Dados nunca apagados do banco |
| **Timing Attack** | Tempo constante no login mesmo com e-mail inválido |

---

## 📡 Endpoints da API

**Base URL:** `http://localhost:3001/api/v1`

### 🔑 Autenticação

| Método | Rota | Descrição | Auth |
|---|---|---|---|
| POST | `/auth/login` | Login do usuário | ❌ |
| POST | `/auth/refresh` | Renovar access token | ❌ |
| GET | `/auth/me` | Dados do usuário logado | ✅ |
| PATCH | `/auth/change-password` | Alterar senha | ✅ |
| POST | `/auth/register` | Criar usuário (admin only) | ✅ Admin |

**Login:**
```json
POST /auth/login
{
  "email": "admin@iphonestore.com.br",
  "password": "Admin@123"
}
```

**Resposta:**
```json
{
  "user": { "id": "uuid", "name": "Administrador", "role": "admin" },
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG...",
  "expiresIn": "8h"
}
```

---

### 👤 Clientes

| Método | Rota | Descrição |
|---|---|---|
| GET | `/clients` | Listar clientes (paginado + filtros) |
| GET | `/clients/:id` | Buscar cliente + histórico de OSs |
| POST | `/clients` | Cadastrar cliente |
| PUT | `/clients/:id` | Atualizar cliente |
| DELETE | `/clients/:id` | Excluir cliente (soft delete) |
| GET | `/clients/cep/:cep` | Consultar endereço pelo CEP |

**Criar cliente:**
```json
POST /clients
Authorization: Bearer {token}

{
  "name": "Maria Silva Santos",
  "cpf": "529.982.247-25",
  "phone": "(11) 98765-4321",
  "email": "maria@email.com",
  "cep": "01310-100"
}
```

**Filtros disponíveis:**
```
GET /clients?search=maria&page=1&limit=20&city=São Paulo&state=SP
```

---

### 📋 Ordens de Serviço

| Método | Rota | Descrição |
|---|---|---|
| GET | `/orders` | Listar OSs (paginado + filtros) |
| GET | `/orders/stats` | Estatísticas do dashboard |
| GET | `/orders/:id` | Buscar OS completa |
| GET | `/orders/:id/warranty-pdf` | Download do PDF de garantia |
| POST | `/orders` | Criar OS (gera PDF + envia e-mail) |
| PATCH | `/orders/:id/status` | Atualizar status |
| DELETE | `/orders/:id` | Excluir OS (admin only) |

**Criar OS (venda):**
```json
POST /orders
Authorization: Bearer {token}

{
  "client_id": "uuid-do-cliente",
  "type": "venda",
  "iphone_model": "iPhone 15 Pro",
  "capacity": "256GB",
  "color": "Titânio Natural",
  "imei": "351234567890123",
  "price": 6899.00,
  "warranty_months": 12,
  "payment_methods": ["pix", "iphone_entrada"],
  "notes": "iPhone em excelente estado, caixa original."
}
```

**Filtros:**
```
GET /orders?type=venda&status=aberto&search=iphone+15&start_date=2024-01-01
```

**Status disponíveis:** `aberto` → `em_andamento` → `concluido` / `cancelado`

---

### 📦 Catálogo

```
GET /catalog/iphone-models   # Lista todos os 46 modelos de iPhone
```

---

## 🗄️ Modelo do Banco

```
users ─────────────────────────────┐
  id, name, email, password_hash   │ created_by
  role (admin|vendedor|tecnico)     │
  is_active, last_login            │
                                   │
clients ──────────────────────────▶ service_orders
  id, name, cpf (único)              id, order_number (único)
  phone, email                       type (venda|manutencao)
  cep, address, city, state          status, iphone_model
  deleted_at (soft delete)           capacity, color, imei
                                     price, payment_methods (JSONB)
                                     warranty_months
                                     deleted_at (soft delete)
```

---

## 📊 Credenciais Padrão (após seed)

| Usuário | E-mail | Senha | Role |
|---|---|---|---|
| Administrador | admin@iphonestore.com.br | Admin@123 | admin |
| Vendedor | vendedor@iphonestore.com.br | Vendedor@123 | vendedor |

> ⚠️ **Altere as senhas em produção!**

---

## 🔧 Variáveis de Ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `PORT` | Porta do servidor | `3001` |
| `DB_*` | Conexão PostgreSQL | — |
| `JWT_SECRET` | Chave do access token (min 32 chars) | — |
| `JWT_REFRESH_SECRET` | Chave do refresh token | — |
| `EMAIL_*` | Configuração SMTP | — |
| `CORS_ORIGIN` | Origens permitidas | `localhost:3000` |
| `BCRYPT_ROUNDS` | Rounds de hash de senha | `12` |

---

## 📬 Fluxo Automático de Garantia

```
POST /orders
  │
  ├─▶ Salva OS no banco (transação)
  ├─▶ Gera PDF com PDFKit (dados do cliente + produto + garantia)
  ├─▶ Envia PDF por e-mail via SMTP (Nodemailer)
  └─▶ Retorna OS + PDF em base64 na resposta
```

Se o e-mail falhar, a OS é criada normalmente. O PDF pode ser baixado a qualquer momento via `GET /orders/:id/warranty-pdf`.

---

## 🚀 Sugestões para Produção

- [ ] Deploy: Railway, Render, Fly.io ou VPS com PM2
- [ ] Banco: Supabase, Neon ou RDS (PostgreSQL gerenciado)
- [ ] E-mail: Trocar SMTP para SendGrid ou Resend (mais confiável)
- [ ] PDF: Armazenar no S3/Cloudflare R2 em vez de gerar on-demand
- [ ] Monitoramento: Sentry para erros, Datadog para métricas
- [ ] CI/CD: GitHub Actions com testes automáticos
- [ ] Cache: Redis para sessões e rate limiting distribuído
