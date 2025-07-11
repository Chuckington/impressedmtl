// supabase/functions/process-square-payment/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"; // Version de std mise à jour
// Importer le SDK Square.
// Pour Deno, il est souvent plus simple d'utiliser un CDN comme esm.sh.
// Essayons une version plus récente du SDK Square.
import { Client, Environment, ApiError } from "https://esm.sh/square@39.0.0"; // Mise à jour de la version
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
    const { sourceId, amount, currency, locationId, idempotencyKey, cartDetails, shippingDetails, userId } = await req.json(); // Ajout de userId
    console.log("Données reçues pour le paiement:", { sourceId, amount, currency, locationId, idempotencyKey });

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

    const squareEnvironment = SQUARE_ENVIRONMENT_STR === "production"
      ? Environment.Production
      : Environment.Sandbox;

    console.log("Utilisation de l'environnement Square:", squareEnvironment);

    // 4. Initialiser le client Square
    const client = new Client({
      accessToken: SQUARE_ACCESS_TOKEN,
      environment: squareEnvironment,
    });

    // 5. Créer le paiement avec l'API Square
    console.log("Tentative de création de paiement avec l'API Square...");
    const { result, statusCode } = await client.paymentsApi.createPayment({
      sourceId: sourceId, // Le token de carte obtenu côté client
      idempotencyKey: idempotencyKey, // Clé unique pour éviter les doubles paiements
      amountMoney: {
        amount: BigInt(amount), // Montant en centimes, Square attend un BigInt
        currency: currency,     // Ex: 'CAD'
      },
      locationId: locationId, // L'ID de votre localisation Square
      // Optionnel: ajoutez des détails supplémentaires si nécessaire
      // note: `Commande pour ${cartDetails?.[0]?.product_name || 'un article'}`,
      // orderId: 'VOTRE_ID_COMMANDE_INTERNE_SI_APPLICABLE' // Si vous avez un système d'ID de commande
    });

    console.log("Réponse de l'API Square (création paiement):", { statusCode, payment_details: result.payment });

    // 6. Gérer la réponse de Square
    if (result.payment && (result.payment.status === 'COMPLETED' || result.payment.status === 'APPROVED')) {
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
      const supabaseAdminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("MY_SERVICE_ROLE_KEY")! // Rétablissement du nom de variable personnalisé, comme vous l'aviez indiqué.
      ); 

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
        const emailHtmlBody = formatOrderDetailsForEmail(cartDetails, shippingDetails, newOrderNumber, amount);
        await sendReceiptEmail(shippingDetails.email, `Confirmation de votre commande Impressed MTL #${newOrderNumber}`, emailHtmlBody);
        await sendReceiptEmail("impressed.mtl@gmail.com", `Nouvelle commande #${newOrderNumber} - Impressed MTL`, emailHtmlBody);
      }

      // Renvoyer la réponse finale avec le bon numéro de commande
      return new Response(JSON.stringify({ success: true, paymentId: paymentId, orderNumber: newOrderNumber }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    } else {
      // Gérer les autres statuts de paiement ou les erreurs renvoyées par Square
      const errorMessage = result.errors?.map(e => `[${e.category}] ${e.code}: ${e.detail}`).join('; ')
        || `Échec du paiement ou statut inattendu: ${result.payment?.status}`;
      console.error("Échec du paiement Square ou statut inattendu:", result);
      return new Response(JSON.stringify({ success: false, message: errorMessage, details: result.errors || { status: result.payment?.status } }), {
        status: 400, // Bad Request, car le paiement n'a pas pu être traité comme attendu
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

  } catch (error) {
    console.error("Erreur inattendue dans la fonction process-square-payment:", error);
    let errorMessage = "Erreur interne du serveur lors du traitement du paiement.";
    let errorDetails: string; // Déclarer sans initialiser immédiatement

    if (error instanceof ApiError) { // Erreur spécifique du SDK Square
        errorMessage = error.errors?.map(e => `[${e.category}] ${e.code}: ${e.detail}`).join('; ') || error.message;
        errorDetails = JSON.stringify(error.errors);
    } else if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack || error.message; // Utiliser stack si disponible pour plus de détails
    } else {
        errorDetails = String(error); // Fallback pour les types d'erreurs inconnus
    }
    return new Response(JSON.stringify({ success: false, message: errorMessage, errorDetails: errorDetails }), {
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
  // Ajoutez d'autres champs si présents dans vos objets cartItem
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

// Fonction pour formater le reçu en HTML
function formatOrderDetailsForEmail(cartItems: CartItem[], shippingInfo: ShippingInfo, orderNumber: number, totalAmountInCents: number): string {
  const itemsHtml = (cartItems || []).map(item => {
    const itemPersonalizationsHtml = (item.personalizations || []).map(p => {
      let detail = `<li>${p.spot_label}: ${p.spot_price.toFixed(2)}$`;
      if (p.image_url) {
        // Pour l'email, une image directe peut être compliquée, un lien est plus sûr
        detail += ` (Design: <a href="${p.image_url}" target="_blank" rel="noopener noreferrer">voir l'image</a>)`;
      }
      detail += `</li>`;
      return detail;
    }).join('');

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
      </div>
    `;
  }).join('');

  const totalAmount = (totalAmountInCents / 100).toFixed(2);

  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Merci pour votre commande, ${shippingInfo.fullName} !</h2>
        <p>Voici le récapitulatif de votre commande <strong>#${orderNumber}</strong> :</p>
        <h3>Articles:</h3>
        ${itemsHtml}
        <h3>Total payé: ${totalAmount}$ (Taxes incluses)</h3>
        <h3>Adresse de livraison:</h3>
        <p>
          ${shippingInfo.fullName}<br>
          ${shippingInfo.address}<br>
          ${shippingInfo.apartment ? shippingInfo.apartment + '<br>' : ''}
          ${shippingInfo.city}, ${shippingInfo.postalCode}<br>
          Téléphone: ${shippingInfo.phone || 'Non fourni'}
        </p>
        <p>Si vous avez des questions, n'hésitez pas à nous contacter.</p>
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
  } catch (error) {
    console.error(`Erreur lors de la requête fetch vers Resend pour ${to}:`, error);
  }
}
