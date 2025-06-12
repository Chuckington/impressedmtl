// supabase/functions/process-square-payment/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"; // Version de std mise à jour
// Importer le SDK Square.
// Pour Deno, il est souvent plus simple d'utiliser un CDN comme esm.sh.
// Vérifiez la dernière version compatible avec Deno sur esm.sh ou la documentation Square.
import { Client, Environment, ApiError } from "https://esm.sh/square@35.0.0"; // Exemple de version, vérifiez la dernière

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
    const { sourceId, amount, currency, locationId, idempotencyKey, _cartDetails } = await req.json(); // cartDetails préfixé
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
      console.log("Paiement Square réussi:", result.payment.id);

      // TODO : Enregistrer la commande dans votre base de données Supabase
      // C'est une étape cruciale pour garder une trace de la commande après un paiement réussi.
      // Exemple (nécessite d'importer et configurer le client Supabase Admin dans la fonction si besoin) :
      /*
      // Importez createClient de Supabase si vous voulez interagir avec la DB ici
      // import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
      // const supabaseAdminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      //
      // const { error: dbError } = await supabaseAdminClient.from('orders').insert({
      //   user_id: cartDetails.user_id, // Assurez-vous que user_id est dans cartDetails ou récupérez-le autrement
      //   square_payment_id: result.payment.id,
      //   total_amount: amount / 100, // Reconvertir en montant décimal
      //   currency: currency,
      //   items: cartDetails, // Les détails du panier
      //   status: 'PAID',
      //   // autres champs pertinents...
      // });
      // if (dbError) {
      //   console.error("Erreur lors de l'enregistrement de la commande en base de données:", dbError);
      //   // Même si l'enregistrement échoue, le paiement a réussi. Gérez ce cas.
      // }
      */

      return new Response(JSON.stringify({ success: true, paymentId: result.payment.id }), {
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
