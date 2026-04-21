-- ================================================================
-- iPhone Store - Migration 001 - Schema Inicial
-- PostgreSQL 14+
-- ================================================================

BEGIN;

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ================================================================
-- TABELA: users (funcionários/admins do sistema)
-- ================================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(150)  NOT NULL,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  role          VARCHAR(20)   NOT NULL DEFAULT 'vendedor'
                CHECK (role IN ('admin', 'vendedor', 'tecnico')),
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE users IS 'Usuários do sistema (funcionários e administradores)';
COMMENT ON COLUMN users.role IS 'admin: acesso total | vendedor: vendas e clientes | tecnico: manutenção';

-- ================================================================
-- TABELA: clients (clientes da loja)
-- ================================================================
CREATE TABLE IF NOT EXISTS clients (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(150)  NOT NULL,
  cpf           VARCHAR(11)   NOT NULL UNIQUE,  -- Armazenado apenas dígitos
  phone         VARCHAR(11)   NOT NULL,          -- Apenas dígitos
  email         VARCHAR(255),
  cep           VARCHAR(8),                      -- Apenas dígitos
  address       VARCHAR(255),
  complement    VARCHAR(100),
  neighborhood  VARCHAR(100),
  city          VARCHAR(100),
  state         CHAR(2),
  deleted_at    TIMESTAMPTZ,                     -- Soft delete
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE clients IS 'Clientes da loja de iPhones';
COMMENT ON COLUMN clients.cpf IS 'CPF armazenado apenas com dígitos (11 chars) para facilitar buscas';
COMMENT ON COLUMN clients.deleted_at IS 'Soft delete: registro mantido para histórico';

-- Índices de busca frequente
CREATE INDEX IF NOT EXISTS idx_clients_cpf        ON clients(cpf) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clients_name       ON clients USING gin(to_tsvector('portuguese', name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clients_phone      ON clients(phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clients_email      ON clients(email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_created_at ON clients(created_at DESC);

-- ================================================================
-- TABELA: service_orders (ordens de serviço / atendimentos)
-- ================================================================
CREATE TABLE IF NOT EXISTS service_orders (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number            VARCHAR(25)   NOT NULL UNIQUE,  -- AT-YYYYMMDD-XXXXX
  client_id               UUID          NOT NULL REFERENCES clients(id),
  created_by              UUID          REFERENCES users(id),

  -- Tipo e status
  type                    VARCHAR(15)   NOT NULL CHECK (type IN ('venda', 'manutencao')),
  status                  VARCHAR(20)   NOT NULL DEFAULT 'aberto'
                          CHECK (status IN ('aberto', 'em_andamento', 'concluido', 'cancelado')),

  -- Produto
  iphone_model            VARCHAR(100)  NOT NULL,
  capacity                VARCHAR(10)   CHECK (capacity IN ('16GB','32GB','64GB','128GB','256GB','512GB','1TB')),
  color                   VARCHAR(50),
  imei                    VARCHAR(15),              -- 15 dígitos (Luhn)

  -- Financeiro
  price                   NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  payment_methods         JSONB         NOT NULL DEFAULT '[]',

  -- Garantia
  warranty_months         SMALLINT      NOT NULL DEFAULT 3 CHECK (warranty_months >= 0 AND warranty_months <= 60),
  warranty_pdf_generated  BOOLEAN       NOT NULL DEFAULT false,
  warranty_email_sent     BOOLEAN       NOT NULL DEFAULT false,
  warranty_email_sent_at  TIMESTAMPTZ,

  -- Extras
  notes                   TEXT,

  -- Auditoria
  deleted_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE service_orders IS 'Ordens de serviço: vendas e manutenções';
COMMENT ON COLUMN service_orders.order_number IS 'Número único gerado: AT-YYYYMMDD-NNNNN';
COMMENT ON COLUMN service_orders.payment_methods IS 'Array JSON de formas de pagamento';
COMMENT ON COLUMN service_orders.imei IS 'International Mobile Equipment Identity (15 dígitos, validado por Luhn)';

-- Índices
CREATE INDEX IF NOT EXISTS idx_orders_client_id   ON service_orders(client_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON service_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_type        ON service_orders(type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status      ON service_orders(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_at  ON service_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_imei        ON service_orders(imei) WHERE imei IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_model       ON service_orders(iphone_model) WHERE deleted_at IS NULL;

-- ================================================================
-- FUNÇÃO: Atualização automática de updated_at
-- ================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplica trigger em todas as tabelas
CREATE TRIGGER set_updated_at_users
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_clients
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_orders
  BEFORE UPDATE ON service_orders
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ================================================================
-- VIEWS ÚTEIS
-- ================================================================

-- Dashboard resumido
CREATE OR REPLACE VIEW vw_dashboard_summary AS
SELECT
  COUNT(*) FILTER (WHERE type = 'venda')         AS total_sales,
  COUNT(*) FILTER (WHERE type = 'manutencao')    AS total_maintenance,
  COUNT(*) FILTER (WHERE status = 'aberto')      AS open_orders,
  COUNT(*) FILTER (WHERE status = 'concluido')   AS completed_orders,
  COALESCE(SUM(price) FILTER (WHERE type = 'venda'), 0) AS total_revenue,
  COALESCE(SUM(price) FILTER (
    WHERE type = 'venda' AND created_at >= DATE_TRUNC('month', NOW())
  ), 0) AS revenue_this_month,
  COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) AS orders_this_month
FROM service_orders
WHERE deleted_at IS NULL;

-- Lista completa de atendimentos
CREATE OR REPLACE VIEW vw_orders_full AS
SELECT
  so.id, so.order_number, so.type, so.status,
  so.iphone_model, so.capacity, so.color, so.imei,
  so.price, so.warranty_months, so.payment_methods,
  so.notes, so.warranty_pdf_generated, so.warranty_email_sent,
  so.created_at, so.updated_at,
  c.id AS client_id, c.name AS client_name,
  c.cpf AS client_cpf, c.phone AS client_phone,
  c.email AS client_email,
  u.name AS created_by_name
FROM service_orders so
JOIN clients c ON c.id = so.client_id
LEFT JOIN users u ON u.id = so.created_by
WHERE so.deleted_at IS NULL;

COMMIT;
