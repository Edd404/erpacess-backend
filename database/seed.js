require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD }
);

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('🌱 Iniciando seed do banco de dados...\n');

    const passwordHash = await bcrypt.hash('Admin@123', 12);
    await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('Administrador', 'admin@iphonestore.com.br', $1, 'admin')
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash]);

    const vendedorHash = await bcrypt.hash('Vendedor@123', 12);
    await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ('João Vendedor', 'vendedor@iphonestore.com.br', $1, 'vendedor')
      ON CONFLICT (email) DO NOTHING
    `, [vendedorHash]);

    console.log('✅ Usuários criados:');
    console.log('   Admin:    admin@iphonestore.com.br / Admin@123');
    console.log('   Vendedor: vendedor@iphonestore.com.br / Vendedor@123\n');

    const clients = [
      ['Maria Silva Santos', '52998224725', '11987654321', 'maria@email.com', '01310100', 'Avenida Paulista, 1000', null, 'Bela Vista', 'São Paulo', 'SP'],
      ['Carlos Eduardo Oliveira', '11144477735', '11912345678', 'carlos@email.com', '20040020', 'Avenida Rio Branco, 200', null, 'Centro', 'Rio de Janeiro', 'RJ'],
      ['Ana Paula Rodrigues', '71428793860', '11934567890', null, '30130110', 'Avenida Afonso Pena, 450', null, 'Centro', 'Belo Horizonte', 'MG'],
    ];

    const clientIds = [];
    for (const [name, cpf, phone, email, cep, address, complement, neighborhood, city, state] of clients) {
      const r = await client.query(`
        INSERT INTO clients (name, cpf, phone, email, cep, address, complement, neighborhood, city, state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (cpf) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [name, cpf, phone, email, cep, address, complement, neighborhood, city, state]);
      clientIds.push(r.rows[0].id);
    }
    console.log(`✅ ${clientIds.length} clientes de exemplo criados\n`);

    const adminResult = await client.query(`SELECT id FROM users WHERE email = 'admin@iphonestore.com.br'`);
    const adminId = adminResult.rows[0].id;

    const orders = [
      [clientIds[0], 'AT-20240115-10001', 'venda', 'iPhone 15 Pro', '256GB', 'Titânio Natural', '351234567890123', 6899.00, 12, ['pix']],
      [clientIds[1], 'AT-20240116-10002', 'venda', 'iPhone 14', '128GB', 'Meia-noite', '358765432109876', 4299.00, 6, ['cartao_credito']],
      [clientIds[2], 'AT-20240117-10003', 'manutencao', 'iPhone 13 Pro Max', '256GB', 'Grafite', '354321098765432', 350.00, 3, ['dinheiro', 'pix']],
    ];

    for (const [cid, num, type, model, cap, color, imei, price, warranty, payments] of orders) {
      await client.query(`
        INSERT INTO service_orders 
          (order_number, client_id, created_by, type, iphone_model, capacity, color, imei, price, warranty_months, payment_methods, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (order_number) DO NOTHING
      `, [num, cid, adminId, type, model, cap, color, imei, price, warranty, JSON.stringify(payments), 'concluido']);
    }

    await client.query('COMMIT');
    console.log('🎉 Seed concluído com sucesso!\n');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro no seed:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
