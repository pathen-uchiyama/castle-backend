import express from 'express';
import Stripe from 'stripe';
import { getSupabaseClient } from '../config/supabase';
import { env } from '../config/env';
import { PaymentService } from '../services/PaymentService';

const stripe = new Stripe(env.STRIPE_SECRET_KEY || 'sk_test_123', {
    apiVersion: '2024-12-18.acacia' as any,
    typescript: true
});

const supabase = getSupabaseClient();

export class PaymentController {
    /**
     * Initializes a new Stripe Checkout Session
     * POST /payment/checkout
     */
    static async createCheckout(req: express.Request, res: express.Response) {
        try {
            const { userId, email, priceId, returnUrl, tier } = req.body;
            if (!userId || !email || !priceId || !returnUrl) {
                return res.status(400).json({ error: 'Missing required checkout parameters' });
            }

            const session = await PaymentService.createCheckoutSession(userId, email, priceId, returnUrl, { tier });
            res.status(200).json({ url: session.url });
        } catch (error) {
            res.status(500).json({ error: 'Failed to create checkout session' });
        }
    }

    /**
     * Creates a link to the Stripe Customer Billing Portal
     * POST /payment/portal
     */
    static async createPortal(req: express.Request, res: express.Response) {
        try {
            const { customerId, returnUrl } = req.body;
            if (!customerId || !returnUrl) {
                return res.status(400).json({ error: 'Missing customerId or returnUrl' });
            }

            const portalUrl = await PaymentService.createCustomerPortalSession(customerId, returnUrl);
            res.status(200).json({ url: portalUrl });
        } catch (error) {
            res.status(500).json({ error: 'Failed to create portal session' });
        }
    }

    /**
     * Handles incoming Stripe Webhooks
     * POST /payment/webhook
     */
    static async handleWebhook(req: express.Request, res: express.Response) {
        const sig = req.headers['stripe-signature'];
        let event: Stripe.Event;

        try {
            if (!sig) throw new Error('No signature provided');
            // req.body must be raw string/buffer for Stripe signature verification
            event = stripe.webhooks.constructEvent(req.body, sig as string, env.STRIPE_WEBHOOK_SECRET || 'whsec_123');
        } catch (err: any) {
            console.error(`⚠️  Webhook signature verification failed.`, err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        try {
            // Handle the event
            switch (event.type) {
                case 'checkout.session.completed':
                    const session = event.data.object as Stripe.Checkout.Session;
                    const userId = session.client_reference_id; // Using client_reference_id consistently
                    const customerId = session.customer as string;
                    const tier = session.metadata?.tier || 'explorer';

                    console.log(`💰 Payment Successful for User: ${userId}. Tier: ${tier}`);

                    // Update user's subscription tier in Supabase
                    const { error } = await supabase
                        .from('users')
                        .update({
                            subscription_tier: tier,
                            subscription_status: 'active',
                            stripe_customer_id: customerId,
                            last_payment_date: new Date().toISOString(),
                        })
                        .eq('id', userId);

                    if (error) {
                        console.error(`❌ Database Error during webhook: ${error.message}`);
                        return res.status(500).send('Database Error');
                    }
                    break;
                case 'customer.subscription.deleted':
                    const subscription = event.data.object as Stripe.Subscription;
                    const customer = subscription.customer as string;
                    
                    console.log(`[PaymentController] Subscription canceled for Customer: ${customer}`);

                    const { error: cancelError } = await supabase
                        .from('users')
                        .update({
                            subscription_tier: 'explorer',
                            subscription_status: 'canceled',
                        })
                        .eq('stripe_customer_id', customer);

                    if (cancelError) {
                        console.error(`❌ Cancellation Sync Error: ${cancelError.message}`);
                    }
                    break;
                case 'invoice.payment_succeeded':
                    // Renewals
                    console.log(`[PaymentController] Invoice payment succeeded`);
                    break;
                case 'invoice.payment_failed':
                    console.log(`[PaymentController] Invoice payment failed!`);
                    break;
                default:
                    console.log(`Unhandled event type ${event.type}`);
            }

            // Return a 200 response to acknowledge receipt of the event
            res.send();
        } catch (error) {
            console.error('[PaymentController] Error processing webhook:', error);
            res.status(500).json({ error: 'Webhook handler failed' });
        }
    }
}
