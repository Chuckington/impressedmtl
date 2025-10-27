// supabase/functions/calculate-shipping/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import EasyPost from 'https://esm.sh/@easypost/api@7.2.0'; // CORRIGÉ: Import via esm.sh

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- 1. Récupérer les données envoyées par le client ---
    const { cart, shippingAddress } = await req.json();

    if (!cart || cart.length === 0 || !shippingAddress) {
      throw new Error("Les détails du panier ou l'adresse de livraison sont manquants.");
    }

    // --- 2. Initialiser les clients (Supabase & EasyPost) ---
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? '',
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ''
    );

    const easyPostApiKey = Deno.env.get("EASYPOST_API_KEY");
    if (!easyPostApiKey) {
      throw new Error("La clé API EasyPost (EASYPOST_API_KEY) n'est pas configurée dans les secrets de la fonction.");
    }
    const easyPostClient = new EasyPost(easyPostApiKey);

    // --- 3. Calculer le poids total du colis ---
    const productIds = cart.map((item: { product_id: string }) => item.product_id);
    
    const { data: productsData, error: productsError } = await supabaseAdmin
      .from('products')
      .select('id, weight_grams')
      .in('id', productIds);

    if (productsError) throw productsError;

    const productsWeightMap = new Map(productsData.map(p => [p.id, p.weight_grams]));
    
    let totalWeightGrams = 0;
    cart.forEach((item: { product_id: string; quantity: number }) => {
      const weight = productsWeightMap.get(parseInt(item.product_id.replace('v2_', ''), 10)) || 150; // 150g par défaut
      totalWeightGrams += weight * item.quantity;
    });

    // Convertir en onces (oz) car c'est l'unité standard pour EasyPost
    const totalWeightOunces = totalWeightGrams * 0.035274;

    // --- 4. Créer les objets Adresse et Colis pour EasyPost ---
    
    // Votre adresse d'expédition (l'origine)
    const fromAddress = await easyPostClient.Address.create({
      street1: '123 Rue Fictive', // **À CHANGER**
      city: 'Montréal',           // **À CHANGER**
      state: 'QC',                // **À CHANGER**
      zip: 'H1H 1H1',             // **À CHANGER**
      country: 'CA',
      company: 'Impressed MTL',
      phone: '514-555-1234'       // **À CHANGER**
    });

    // L'adresse du client (la destination)
    const toAddress = await easyPostClient.Address.create({
      street1: shippingAddress.address,
      street2: shippingAddress.apartment,
      city: shippingAddress.city,
      state: 'QC', // Pour l'instant, on suppose que c'est toujours au Québec
      zip: shippingAddress.postalCode,
      country: 'CA',
      name: shippingAddress.fullName,
      email: shippingAddress.email,
      phone: shippingAddress.phone
    });

    // Le colis lui-même
    const parcel = await easyPostClient.Parcel.create({
      length: 12, // en pouces (inches) - **À AJUSTER**
      width: 10,  // en pouces (inches) - **À AJUSTER**
      height: 5,  // en pouces (inches) - **À AJUSTER**
      weight: totalWeightOunces, // en onces (oz)
    });

    // --- 5. Créer l'envoi et récupérer les tarifs ---
    const shipment = await easyPostClient.Shipment.create({
      to_address: toAddress,
      from_address: fromAddress,
      parcel: parcel,
    });

    // --- 6. Formatter et renvoyer les tarifs au client ---
    // Définir un type pour les objets "rate" d'EasyPost pour éviter 'any'
    interface EasyPostRate {
      id: string;
      carrier: string;
      service: string;
      rate: string;
      currency: string;
      delivery_days: number | null;
    }

    const rates = shipment.rates.map((rate: EasyPostRate) => ({
      id: rate.id,
      service: `${rate.carrier} ${rate.service}`,
      amount: parseFloat(rate.rate),
      currency: rate.currency,
      delivery_days: rate.delivery_days,
    }));

    return new Response(JSON.stringify({ rates }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error("Erreur dans la fonction calculate-shipping:", error);
    const errorMessage = error instanceof Error ? error.message : "Une erreur inconnue est survenue.";
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});