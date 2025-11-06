// supabase/functions/process-square-payment/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"; // Version de std mise à jour
// NOUVEAU: On retire l'import du SDK Square qui cause des problèmes de compatibilité.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';


console.log("Initialisation de la fonction process-square-payment");

serve(async (req) => {
  // 1. Gérer les requêtes CORS (Cross-Origin Resource Sharing)
  // C'est important pour que votre page web (servie depuis un domaine)
  // puisse appeler cette fonction (servie depuis le domaine de Supabase).
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*", // Pour le développement. En production, mettez votre domaine spécifique.
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    // 2. Extraire les données du corps de la requête
    const { sourceId, amount, currency, locationId, idempotencyKey, cartDetails, shippingDetails, userId, maquetteRequested, promoCodeDetails, specialOfferDiscount, shippingCost, shippingService, shippingDeliveryDays } = await req.json();
    console.log("Données reçues pour le paiement:", { sourceId, amount, currency, locationId, idempotencyKey, maquetteRequested });

    // Initialiser le client admin Supabase (nécessaire pour l'enrichissement des données et la sauvegarde)
    const supabaseAdminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("MY_SERVICE_ROLE_KEY")!
    );

    // NOUVEAU: Enrichir les détails du panier avec les assets des produits
    // C'est plus robuste que de se fier aux données envoyées par le client, qui peuvent être incomplètes.
    const productIds = (cartDetails || [])
        .map((item: CartItem) => item.product_id.startsWith('v2_') ? item.product_id.replace('v2_', '') : null)
        .filter((id: string | null): id is string => id !== null);

    if (productIds.length > 0) {
        const { data: productsData, error: productsError } = await supabaseAdminClient
            .from('products')
            .select('id, asset_base_front, asset_base_back, asset_base_sleeve_left, asset_base_sleeve_right')
            .in('id', productIds);

        if (!productsError && productsData) {
            const productsMap = new Map(productsData.map((p: {
                id: number;
                asset_base_front: string | null;
                asset_base_back: string | null;
                asset_base_sleeve_left: string | null;
                asset_base_sleeve_right: string | null;
            }) => [p.id, p]));
            cartDetails.forEach((item: CartItem) => {
                if (item.product_id.startsWith('v2_')) {
                    const productId = parseInt(item.product_id.replace('v2_', ''), 10);
                    const productAssets = productsMap.get(productId);
                    if (productAssets) item.product_assets = productAssets;
                }
            });
        } else if (productsError) {
            console.error("Erreur lors de la récupération des assets des produits:", productsError);
        }
    }

    // **Validation Côté Serveur**
    // C'est une sécurité essentielle. Même si le client valide, il faut toujours vérifier côté serveur.
    if (!sourceId || !amount || !currency || !locationId || !idempotencyKey || !shippingDetails || !shippingDetails.fullName || !shippingDetails.email) {
      console.error("Validation échouée: Données de paiement ou de livraison manquantes.", { sourceId, amount, currency, locationId, idempotencyKey, shippingDetails });
      return new Response(JSON.stringify({ success: false, message: "Données de la requête invalides ou manquantes." }), {
        status: 400, // Bad Request
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 3. Récupérer les secrets depuis les variables d'environnement Supabase
    // Ces secrets sont configurés dans votre tableau de bord Supabase ou via la CLI.
    const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
    
    // Alternative pour SQUARE_ENVIRONMENT_STR pour plus de clarté ou pour satisfaire certains linters
    const squareEnvValue = Deno.env.get("SQUARE_ENVIRONMENT");
    const SQUARE_ENVIRONMENT_STR = squareEnvValue ? squareEnvValue.toLowerCase() : "sandbox"; // sandbox par défaut
    
    if (!SQUARE_ACCESS_TOKEN) {
      console.error("ERREUR: SQUARE_ACCESS_TOKEN n'est pas défini dans les secrets de la fonction.");
      return new Response(JSON.stringify({ success: false, message: "Configuration serveur manquante (token d'accès)." }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // NOUVEAU: Définir l'URL de l'API Square en fonction de l'environnement
    const squareApiUrl = SQUARE_ENVIRONMENT_STR === "production"
      ? "https://connect.squareup.com/v2/payments"
      : "https://connect.squareupsandbox.com/v2/payments";

    console.log("Utilisation de l'environnement Square:", SQUARE_ENVIRONMENT_STR);

    const maquetteFee = maquetteRequested === true ? 5 : 0;

    // Calculer les détails financiers pour la note de paiement Square
    const subTotalForNote = (cartDetails || []).reduce((sum: number, item: CartItem) => {
        const itemExtraCost = (item.personalizations || []).reduce((pSum, p) => pSum + p.spot_price, 0);
        return sum + (item.quantity * (item.base_price + itemExtraCost));
    }, 0);

    const totalItemCountForNote = (cartDetails || []).reduce((sum: number, item: CartItem) => sum + item.quantity, 0);
    let fixedFeeForNote = 0;
    if (totalItemCountForNote === 1) fixedFeeForNote = 15;
    else if (totalItemCountForNote >= 2 && totalItemCountForNote <= 9) fixedFeeForNote = 10;

    const discountApplied = (cartDetails || []).length > 0 ? (subTotalForNote + fixedFeeForNote + maquetteFee) - (amount / 100) : 0;

    const paymentNoteParts = [];
    if (maquetteFee > 0) paymentNoteParts.push(`Frais maquette: ${maquetteFee.toFixed(2)}$`);
    if (discountApplied > 0.01) paymentNoteParts.push(`Rabais: -${discountApplied.toFixed(2)}$`);

    // 5. Créer le paiement en appelant directement l'API Square avec fetch
    console.log("Tentative de création de paiement avec l'API Square...");
    const squareResponse = await fetch(squareApiUrl, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-05-15', // Version de l'API
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: idempotencyKey,
        amount_money: {
          amount: amount, // Le montant est déjà en centimes (number)
          currency: currency
        },
        location_id: locationId,
        note: paymentNoteParts.length > 0 ? paymentNoteParts.join(' | ') : undefined
      })
    });

    const result = await squareResponse.json();

    console.log("Réponse de l'API Square (création paiement):", { status: squareResponse.status, body: result });

    // 6. Gérer la réponse de Square
    if (squareResponse.ok && result.payment && (result.payment.status === 'COMPLETED' || result.payment.status === 'APPROVED')) {
      const paymentId = result.payment.id;

      if (!paymentId) {
        console.error("ERREUR: ID de paiement manquant dans la réponse Square après un paiement réussi.");
        return new Response(JSON.stringify({ success: false, message: "Erreur interne: ID de paiement manquant." }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // À partir d'ici, paymentId est garanti d'être une chaîne de caractères.
      console.log("Paiement Square réussi:", paymentId);

      // Enregistrer la commande dans la base de données Supabase
      let fixedFeeApplied = 0;
      const totalItemCount = (cartDetails || []).reduce((sum: number, item: CartItem) => sum + item.quantity, 0);
      if (totalItemCount === 1) fixedFeeApplied = 15;
      else if (totalItemCount >= 2 && totalItemCount <= 9) fixedFeeApplied = 10;

      // Appel de la fonction RPC pour créer la commande et récupérer son ID/numéro en une seule opération atomique.
      const { data: rpcData, error: rpcError } = await supabaseAdminClient.rpc(
        'create_order_and_get_number',
        {
          p_user_id: userId || null,
          p_square_payment_id: paymentId,
          p_total_amount: amount / 100,
          p_currency: currency,
          p_shipping_fullname: shippingDetails.fullName,
          p_shipping_email: shippingDetails.email,
          p_shipping_address: shippingDetails.address,
          p_shipping_apartment: shippingDetails.apartment,
          p_shipping_city: shippingDetails.city,
          p_shipping_postalcode: shippingDetails.postalCode,
          p_shipping_phone: shippingDetails.phone,
          p_fixed_fee_applied: fixedFeeApplied
        }
      );

      if (rpcError || !rpcData) {
        console.error("ERREUR CRITIQUE: L'appel RPC 'create_order_and_get_number' a échoué.", rpcError);
        // Le paiement a réussi, mais la sauvegarde a échoué. On ne peut pas continuer.
        // On renvoie un succès partiel au client pour ne pas l'inquiéter, mais on log l'ID de paiement pour une action manuelle.
        return new Response(JSON.stringify({ success: true, paymentId: paymentId, orderNumber: null, error: "DB RPC failed" }), {
          status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // L'appel RPC a réussi. rpcData est maintenant un objet JSON simple.
      const newOrderId = rpcData.order_id;
      const newOrderNumber = rpcData.order_number;

      // Vérification de sécurité pour s'assurer que la RPC a bien retourné les données attendues.
      if (!newOrderId || !newOrderNumber) {
        console.error("ERREUR CRITIQUE: La RPC a réussi mais n'a pas retourné order_id ou order_number.", rpcData);
        return new Response(JSON.stringify({ success: true, paymentId: paymentId, orderNumber: null, error: "DB RPC returned invalid data" }), {
          status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      console.log(`Commande enregistrée et récupérée avec ID: ${newOrderId} et Numéro de Commande: #${newOrderNumber}`);

      // Enregistrer les articles de la commande dans 'order_items' en utilisant le newOrderId
      if (cartDetails && cartDetails.length > 0) {
        const orderItemsToInsert = cartDetails.map((item: CartItem) => {
          let itemExtraCost = 0;
          (item.personalizations || []).forEach(p => itemExtraCost += (p.spot_price || 0));
          return {
            order_id: newOrderId, // Utilisation de l'ID récupéré
            product_id: item.product_id,
            product_name: item.product_name,
            quantity: item.quantity,
            base_price: item.base_price,
            final_preview_url: item.final_preview_url, // NOUVEAU: Sauvegarder l'URL de l'aperçu final
            product_assets: item.product_assets, // Sauvegarder les assets avec la commande
            personalizations: item.personalizations,
            selected_color_name: item.selected_color_name,
            selected_size_name: item.selected_size_name,
            selected_gender_name: item.selected_gender_name,
            item_total_price: (item.quantity * (item.base_price + itemExtraCost))
          };
        });
        const { error: itemsError } = await supabaseAdminClient.from('order_items').insert(orderItemsToInsert);
        if (itemsError) {
          console.error("Erreur lors de l'enregistrement des articles de la commande (table order_items):", itemsError);
        } else {
          console.log("Articles de la commande enregistrés avec succès pour order_id:", newOrderId);
        }
      }
      
      // Envoyer les emails de confirmation
      if (shippingDetails && shippingDetails.email && cartDetails) {
        const emailHtmlBody = formatOrderDetailsForEmail(cartDetails, shippingDetails, newOrderNumber, amount, maquetteRequested, fixedFeeApplied, promoCodeDetails || null, specialOfferDiscount || 0, { cost: shippingCost, service: shippingService, days: shippingDeliveryDays });
        await sendReceiptEmail(shippingDetails.email, `Confirmation de ta commande Impressed MTL #${newOrderNumber}`, emailHtmlBody);
        await sendReceiptEmail("impressed.mtl@gmail.com", `Nouvelle commande #${newOrderNumber} - Impressed MTL`, emailHtmlBody);
      }

      // Renvoyer la réponse finale avec le bon numéro de commande
      return new Response(JSON.stringify({ success: true, paymentId: paymentId, orderNumber: newOrderNumber }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    } else {
      // Gérer les autres statuts de paiement ou les erreurs renvoyées par Square
      // CORRECTION: Définir un type pour les erreurs de l'API Square pour éviter 'any'
      interface SquareApiError {
        category: string;
        code: string;
        detail: string;
      }
      const errorMessage = result.errors?.map((e: SquareApiError) => `[${e.category}] ${e.code}: ${e.detail}`).join('; ')
        || `Échec du paiement ou statut inattendu: ${result.payment?.status}`;
      console.error("Échec du paiement Square ou statut inattendu:", result);
      return new Response(JSON.stringify({ success: false, message: errorMessage, details: result.errors || { status: result.payment?.status } }), {
        status: 400, // Bad Request, car le paiement n'a pas pu être traité comme attendu
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

  } catch (error) {
    console.error("Erreur inattendue dans la fonction process-square-payment:", error);
    // CORRECTION: Gestion d'erreur simplifiée et sécurisée
    let errorMessage = "Une erreur interne est survenue.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = String(error);
    }
    return new Response(JSON.stringify({ success: false, message: errorMessage }), {
      status: 500, // Erreur serveur
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});

// Définir des types pour une meilleure clarté et sécurité
interface PersonalizationDetail {
  spot_label: string;
  spot_price: number;
  image_url?: string;
  view?: string;
}

interface CartItem {
  product_id: string; // Ajout de la propriété manquante
  product_name: string;
  quantity: number;
  base_price: number;
  personalizations?: PersonalizationDetail[];
  selected_color_name?: string;
  selected_size_name?: string;
  selected_gender_name?: string;
  product_assets?: {
    id: number;
    asset_base_front: string | null;
    asset_base_back: string | null;
    asset_base_sleeve_left: string | null;
    asset_base_sleeve_right: string | null;
  };
  final_preview_url?: string;
}

interface PromoCode {
  code: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
}

interface ShippingInfo {
  fullName: string;
  email: string;
  address: string;
  apartment?: string;
  city: string;
  postalCode: string;
  phone?: string;
}

interface ShippingDetailsForEmail {
  cost: number;
  service: string;
  days: number | null;
}

// Fonction pour formater le reçu en HTML
function formatOrderDetailsForEmail(cartItems: CartItem[], shippingInfo: ShippingInfo, orderNumber: number, totalAmountInCents: number, maquetteRequested: boolean, fixedFee: number, promoCode: PromoCode | null, specialOfferDiscount: number, shippingDetails: ShippingDetailsForEmail): string {
  const itemsHtml = (cartItems || []).map(item => {
    const itemPersonalizationsHtml = (item.personalizations || []).map(p => {
      let detail = `<li><strong>${p.spot_label}</strong> (+${p.spot_price.toFixed(2)}$)<br>`;
      
      // Afficher le design seul
      if (p.image_url) {
        detail += `Design: <br><img src="${p.image_url}" alt="Design pour ${p.spot_label}" style="max-width: 100px; max-height: 100px; border: 1px solid #ddd; margin-top: 5px; margin-bottom: 5px;"><br>`;
      }
      detail += `</li>`;
      return detail;
    }).join('');

    // NOUVEAU: Ajouter l'aperçu final s'il existe
    const finalPreviewHtml = item.final_preview_url ? `
      <div style="margin-top: 10px;">
        <strong>Aperçu du produit final:</strong><br>
        <img src="${item.final_preview_url}" alt="Aperçu final pour ${item.product_name}" style="max-width: 200px; max-height: 200px; border: 1px solid #ddd; margin-top: 5px;">
      </div>
    ` : '';

    const options = [];
    if (item.selected_color_name) options.push(`Couleur: ${item.selected_color_name}`);
    if (item.selected_size_name) options.push(`Taille: ${item.selected_size_name}`);
    if (item.selected_gender_name) options.push(`Sexe: ${item.selected_gender_name}`);
    
    const itemOptionsHtml = options.length > 0 ? `<li>Options: ${options.join(', ')}</li>` : '';

    return `
      <div style="border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 10px;">
        <strong>${item.product_name} x ${item.quantity}</strong><br>
        Prix de base unitaire: ${item.base_price.toFixed(2)}$<br>
        ${itemPersonalizationsHtml ? `Personnalisations:<ul>${itemPersonalizationsHtml}</ul>` : 'Personnalisations: Aucune'}<br>
        ${itemOptionsHtml}
        ${finalPreviewHtml}
      </div>
    `;
  }).join('');

  const subTotal = (cartItems || []).reduce((sum, item) => {
    const itemExtraCost = (item.personalizations || []).reduce((pSum, p) => pSum + p.spot_price, 0);
    return sum + (item.quantity * (item.base_price + itemExtraCost));
  }, 0);

  const maquetteFee = maquetteRequested ? 5 : 0;
  const totalBeforePromo = subTotal - specialOfferDiscount + fixedFee + maquetteFee;
  let promoDiscountValue = 0;
  if (promoCode) {
      if (promoCode.discount_type === 'percentage') {
          promoDiscountValue = totalBeforePromo * (promoCode.discount_value / 100);
      } else if (promoCode.discount_type === 'fixed') {
          promoDiscountValue = promoCode.discount_value;
      }
      if (promoDiscountValue > totalBeforePromo) {
          promoDiscountValue = totalBeforePromo;
      }
  }

  const totalAmount = (totalAmountInCents / 100).toFixed(2);

  const promoCodeHtml = promoCode ? `
    <p style="color: #28a745;">
      Code promotionnel appliqué (<strong>${promoCode.code}</strong>): -${promoDiscountValue.toFixed(2)}$
    </p>
  ` : '';

  // NOUVEAU: Section pour les détails de la livraison
  const shippingCost = shippingDetails.cost || 0;
  const shippingHtml = `
    <p>Livraison (${shippingDetails.service}): ${shippingCost.toFixed(2)}$</p>
    ${shippingDetails.days ? `<p style="font-size: 0.9em; color: #555;"><i>Délai total estimé (production + livraison) : <strong>${shippingDetails.days} jour(s) ouvrables.</strong></i></p>` : ''}
  `;

  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Merci pour ta commande, ${shippingInfo.fullName} !</h2>
        <p>Voici le récapitulatif de ta commande <strong>#${orderNumber}</strong> :</p>
        <h3>Articles:</h3>
        ${itemsHtml}
        <p>Sous-total: ${subTotal.toFixed(2)}$</p>
        ${specialOfferDiscount > 0 ? `<p style="color: #28a745;">Rabais Offre Spéciale: -${specialOfferDiscount.toFixed(2)}$</p>` : ''}
        ${fixedFee > 0 ? `<p>Frais de préparation: ${fixedFee.toFixed(2)}$</p>` : ''}
        <p>Maquette demandée: <strong>${maquetteRequested ? 'Oui' : 'Non'}</strong> (+${maquetteFee.toFixed(2)}$)</p>
        ${shippingHtml}
        ${promoCodeHtml}
        <h3>Total payé: ${totalAmount}$ (Taxes incluses)</h3>
        <h3>Adresse de livraison:</h3>
        <p>
          ${shippingInfo.fullName}<br>
          ${shippingInfo.address}<br>
          ${shippingInfo.apartment ? shippingInfo.apartment + '<br>' : ''}
          ${shippingInfo.city}, ${shippingInfo.postalCode}<br>
          Téléphone: ${shippingInfo.phone || 'Non fourni'}
        </p>
        <p>Si tu as des questions, n'hésite pas à nous contacter.</p>
        <p>L'équipe Impressed MTL</p>
      </body>
    </html>
  `;
}

// Fonction pour envoyer l'email via Resend
async function sendReceiptEmail(to: string, subject: string, htmlBody: string): Promise<void> {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY n'est pas configurée.");
    return; // Ne pas continuer si la clé API est manquante
  }

  const resendPayload = {
    from: 'Impressed MTL <commandes@impressedmtl.com>', // Ou une autre adresse comme noreply@impressedmtl.com
    to: [to],
    subject: subject,
    html: htmlBody,
  };

  console.log(`Tentative d'envoi d'email à ${to} avec sujet: ${subject}`);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendPayload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`Erreur Resend (HTTP ${response.status}) lors de l'envoi à ${to}:`, errorData);
    } else {
      const responseData = await response.json();
      console.log(`Email envoyé avec succès à ${to}. ID Resend: ${responseData.id}`);
    }
  } catch (e: unknown) {
    console.error(`Erreur lors de la requête fetch vers Resend pour ${to}:`, e);
  }
}
