// ═══════════════════════════════════════════════════════
// ProduzAI — Stripe Webhook Handler
// Deploy em: /api/stripe-webhook.js (Vercel)
// ═══════════════════════════════════════════════════════

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── MAPA DE PRICE_IDS → PLANO INTERNO ────────────────────
const PRICE_TO_PLANO = {
  // Básico — até 10 usuários
  'price_1TCLVgHjERhCMLJsmv69oA4Y': { plano: 'basico',        ciclo: 'mensal',    max_usuarios: 10 },
  'price_1TCLYyHjERhCMLJs73mh9iT5': { plano: 'basico',        ciclo: 'semestral', max_usuarios: 10 },
  // Starter — até 20 usuários
  'price_1TCLbVHjERhCMLJs4NMsI3qL': { plano: 'starter',       ciclo: 'mensal',    max_usuarios: 20 },
  // Profissional — ilimitado
  'price_1TCLcPHjERhCMLJsjgbmM4SD': { plano: 'profissional',  ciclo: 'mensal',    max_usuarios: 999 },
  'price_1TCLiGHjERhCMLJsdMbm3zY9': { plano: 'profissional',  ciclo: 'semestral', max_usuarios: 999 },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const priceId = sub.items.data[0]?.price?.id;
      const info = PRICE_TO_PLANO[priceId] || { plano: 'basico', ciclo: 'mensal', max_usuarios: 10 };

      await supabase.rpc('atualizar_plano_stripe', {
        p_stripe_customer_id:  sub.customer,
        p_stripe_sub_id:       sub.id,
        p_plano_id:            info.plano,
        p_ativo:               sub.status === 'active',
      });

      // Atualizar max_usuarios e ciclo
      await supabase.from('empresas')
        .update({
          stripe_subscription_id: sub.id,
          max_usuarios: info.max_usuarios,
          ciclo_cobranca: info.ciclo,
        })
        .eq('stripe_customer_id', sub.customer);

      console.log(`Plano atualizado: ${sub.customer} → ${info.plano} (${info.ciclo}, ${info.max_usuarios} users)`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await supabase.rpc('atualizar_plano_stripe', {
        p_stripe_customer_id:  sub.customer,
        p_stripe_sub_id:       sub.id,
        p_plano_id:            'basico',
        p_ativo:               false,
      });
      console.log(`Assinatura cancelada: ${sub.customer}`);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await supabase.from('empresas')
        .update({ assinatura_ativa: false })
        .eq('stripe_customer_id', invoice.customer);
      console.log(`Pagamento falhou: ${invoice.customer}`);
      break;
    }

    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode === 'subscription') {
        const empresaId = session.metadata?.empresa_id;
        if (empresaId) {
          await supabase.from('empresas')
            .update({ stripe_customer_id: session.customer })
            .eq('id', empresaId);
        }
      }
      break;
    }
  }

  res.status(200).json({ received: true });
}
