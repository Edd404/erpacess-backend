/**
 * cloudinaryService.js  (BACKEND)
 * Reconstrói signed_document_url a partir do public_id quando a URL foi apagada.
 * O frontend sempre espera o campo signed_document_url.
 */

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dasqf9aie';

/**
 * Garante que signed_document_url está preenchida.
 * Se foi apagada mas o public_id existe, reconstrói a URL pública.
 *
 * @param {object} order — linha da tabela service_orders
 * @returns {object}     — ordem com signed_document_url restaurada
 */
const attachSignedDocumentUrl = (order) => {
  if (!order) return order;

  let url = order.signed_document_url;

  // Reconstrói URL a partir do public_id se foi apagada
  if (!url && order.signed_document_public_id) {
    url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${order.signed_document_public_id}`;
  }

  return {
    ...order,
    signed_document_url: url || null,
    has_document: !!url,
  };
};

module.exports = { attachSignedDocumentUrl };
