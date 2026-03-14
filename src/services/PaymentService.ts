import Stripe from 'stripe';

import { env } from '../config/env';

const stripe = new Stripe(env.STRIPE_SECRET_KEY || 'sk_test_123', {
    apiVersion: '2024-12-18.acacia' as any,
    typescript: true
});

export class PaymentService {
    /**
     * Creates a Stripe Checkout Session for a new subscription.
     */
    static async createCheckoutSession(userId: string, email: string, priceId: string, returnUrl: string, metadata?: Record<string, any>) {
        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price: priceId,
                        quantity: 1,
                    },
                ],
                mode: priceId.includes('annual') ? 'subscription' : 'payment',
                success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}&success=true`,
                cancel_url: `${returnUrl}?canceled=true`,
                customer_email: email,
                client_reference_id: userId,
                metadata: {
                    userId: userId,
                    tier: metadata?.tier || 'explorer'
                }
            });

            return session;
        } catch (error) {
            console.error('[PaymentService] Error creating checkout session:', error);
            throw new Error('Failed to initiate checkout.');
        }
    }

    /**
     * Generates a billing portal link so users can manage their subscription.
     */
    static async createCustomerPortalSession(customerId: string, returnUrl: string) {
        try {
            const portalSession = await stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: returnUrl,
            });

            return portalSession.url;
        } catch (error) {
            console.error('[PaymentService] Error creating portal session:', error);
            throw new Error('Failed to create customer portal session.');
        }
    }
}
