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

      // Préparer et envoyer les emails de confirmation/reçu
      if (shippingDetails && shippingDetails.email && cartDetails) {
        const emailHtmlBody = formatOrderDetailsForEmail(cartDetails, shippingDetails, paymentId, amount);
        await sendReceiptEmail(shippingDetails.email, "Votre reçu de commande Impressed MTL", emailHtmlBody);
        await sendReceiptEmail("impressed.mtl@gmail.com", `Nouvelle commande Impressed MTL - ${paymentId}`, emailHtmlBody);
      }

      // Enregistrer la commande dans la base de données Supabase
      const supabaseAdminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("MY_SERVICE_ROLE_KEY")! // <--- MODIFIEZ CECI pour correspondre au nom que vous avez choisi
      );

      let fixedFeeApplied = 0;
      const totalItemCount = (cartDetails || []).reduce((sum: number, item: CartItem) => sum + item.quantity, 0);
      if (totalItemCount === 1) fixedFeeApplied = 15;
      else if (totalItemCount >= 2 && totalItemCount <= 9) fixedFeeApplied = 10;

      const { data: orderData, error: orderError } = await supabaseAdminClient
        .from('orders')
        .insert([{ // insert expects an array of objects
          user_id: userId || null, // userId est envoyé depuis le client
          square_payment_id: paymentId,
          total_amount: amount / 100, // Montant en dollars
          currency: currency,
          status: 'PAID',
          shipping_fullname: shippingDetails.fullName,
          shipping_email: shippingDetails.email,
          shipping_address: shippingDetails.address,
          shipping_apartment: shippingDetails.apartment,
          shipping_city: shippingDetails.city,
          shipping_postalcode: shippingDetails.postalCode,
          shipping_phone: shippingDetails.phone,
          fixed_fee_applied: fixedFeeApplied
        }])
        .select() // Pour retourner la commande insérée
        .single(); // S'attendre à un seul enregistrement

      if (orderError) {
        console.error("Erreur lors de l'enregistrement de la commande (table orders):", orderError);
        // Le paiement a réussi, mais l'enregistrement de la commande a échoué.
        // Vous devriez logger cela et potentiellement alerter pour une action manuelle.
        // Pour le client, le paiement est toujours considéré comme réussi.
      } else if (orderData && cartDetails && cartDetails.length > 0) {
        console.log("Commande enregistrée avec ID:", orderData.id);
        const orderItemsToInsert = cartDetails.map((item: CartItem) => {
          let itemExtraCost = 0;
          (item.personalizations || []).forEach(p => itemExtraCost += (p.spot_price || 0));
          return {
            order_id: orderData.id,
            product_id: item.product_id, // Assurez-vous que product_id est dans cartDetails
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

        const { error: itemsError } = await supabaseAdminClient
          .from('order_items')
          .insert(orderItemsToInsert);

        if (itemsError) {
          console.error("Erreur lors de l'enregistrement des articles de la commande (table order_items):", itemsError);
          // Idem, logger et alerter.
        } else {
          console.log("Articles de la commande enregistrés pour order_id:", orderData.id);
        }
      }

      return new Response(JSON.stringify({ success: true, paymentId: paymentId }), {
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
function formatOrderDetailsForEmail(cartItems: CartItem[], shippingInfo: ShippingInfo, paymentId: string, totalAmountInCents: number): string {
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
        <p>Voici le récapitulatif de votre commande #${paymentId} :</p>
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
    from: 'Impressed MTL <VOTRE_ADRESSE_EMAIL_VERIFIEE_SUR_RESEND_ICI>', // Exemple: 'Impressed MTL <commandes@votredomaine.com>'
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
