require('dotenv').config();
const express = require('express');
const cors = require('cors');
const SSLCommerzPayment = require('sslcommerz-lts');
const app = express();

const FrontEndURL = process.env.FRONTEND_URL
const BackEndURL = process.env.BACKEND_URL

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// SSLCommerz Config - Verify these are LIVE credentials
const store_id = process.env.SSLC_STORE_ID;
const store_passwd = process.env.SSLC_STORE_PASSWORD;
const is_live = process.env.IS_LIVE === "true" ? true: false; // MUST be true for production

// Verify credentials on startup
console.log('\n=== SSLCommerz Configuration ===');
console.log('Store ID:', store_id);
console.log('Live Mode:', is_live);
console.log('Backend URL:', BackEndURL);
console.log('Frontend URL:', FrontEndURL, '\n');

if (is_live && (store_id.includes('test') || store_passwd.includes('test'))) {
  console.error('ERROR: Using sandbox credentials in live mode!');
  process.exit(1);
}

app.get('/', (req, res) => {
  res.send('Welcome to ShopAntik SSLCommerz Payment Integration');
});

// Payment Redirection Endpoints (Keep your existing URLs)
app.post('/payment/success', (req, res) => {
  const tran_id = req.body.tran_id;
  const orderId = tran_id.split('_')[1];
  res.redirect(`${FrontEndURL}/payment-success?order_id=${orderId}`);
});

app.post('/payment/fail', (req, res) => {
  const orderId = req.body.tran_id.split('_')[1];
  res.redirect(`${FrontEndURL}/payment-failed?order_id=${orderId}`);
});

app.post('/payment/cancel', (req, res) => {
  const orderId = req.body.tran_id.split('_')[1];
  res.redirect(`${FrontEndURL}/payment-cancelled?order_id=${orderId}`);
});

// Initialize Payment (Updated with production-ready changes)
app.post('/api/payment/initiate', async (req, res) => {
    try {
        const { orderData, customer, cartItems } = req.body;

        // Create transaction ID
        const tran_id = `ORDER_${orderData.id}_${Date.now()}`;
        const paymentAmount = orderData.has_discounted_price ? orderData.shipping_cost : orderData.total;

        // Enhanced payment data with production requirements
        const data = {
            total_amount: paymentAmount,
            currency: 'BDT',
            tran_id: tran_id,
            success_url: `${BackEndURL}/payment/success`,
            fail_url: `${BackEndURL}/payment/fail`,
            cancel_url: `${BackEndURL}/payment/cancel`,
            ipn_url: `${BackEndURL}/api/payment/ipn`,
            shipping_method: orderData.shipping_location === 'inside' ? 'Courier' : 'Courier',
            product_name: cartItems.map(item => item.name).join(', ').substring(0, 255),
            product_category: 'Books',
            product_profile: 'physical-goods',
            cus_name: customer.name.substring(0, 50),
            cus_email: customer.email.substring(0, 50),
            cus_add1: customer.address.substring(0, 50),
            cus_city: customer.city.substring(0, 50),
            cus_postcode: customer.postalCode.substring(0, 50),
            cus_country: 'Bangladesh',
            cus_phone: customer.phone.substring(0, 20),
            ship_name: customer.name.substring(0, 50),
            ship_add1: customer.address.substring(0, 50),
            ship_city: customer.city.substring(0, 50),
            ship_postcode: customer.postalCode.substring(0, 50),
            ship_country: 'Bangladesh',
            value_a: orderData.id.toString(),
            emi_option: 0,
            emi_max_inst_option: 0,
            emi_allow_only: 0
        };

        const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
        const apiResponse = await sslcz.init(data);

        // Debug the response
        console.log('SSLCommerz Response:', {
            gatewayUrl: apiResponse.GatewayPageURL,
            status: apiResponse.status,
            sessionkey: apiResponse.sessionkey,
            tran_id: tran_id
        });

        if (!apiResponse.GatewayPageURL) {
            throw new Error('No Gateway URL received from SSLCommerz');
        }

        if (is_live && apiResponse.GatewayPageURL.includes('sandbox')) {
            throw new Error('SSLCommerz returned sandbox URL in live mode!');
        }

        res.json({
            success: true,
            gateway_url: apiResponse.GatewayPageURL,
            tran_id: tran_id
        });

    } catch (error) {
        console.error('Payment Initiation Error:', {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        
        res.status(500).json({
            success: false,
            message: 'Payment initiation failed',
            error: error.message
        });
    }
});

// IPN Handler (Keep your existing implementation)
app.post('/api/payment/ipn', async (req, res) => {
  try {
    const { val_id, tran_id, status, value_a: orderId } = req.body;
    
    const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
    const validationData = await sslcz.validate({ val_id });

    let orderUpdate = {
      payment_data: validationData,
      sslcommerz_tran_id: tran_id,
      updated_at: new Date().toISOString()
    };

    switch(status) {
      case 'VALID':
      case 'VALIDATED':
        orderUpdate.status = validationData.value_b === 'cod_partial' 
          ? 'processing' 
          : 'paid';
        orderUpdate.payment_status = validationData.value_b === 'cod_partial'
          ? 'delivery_paid'
          : 'paid';
        break;
      case 'FAILED':
        orderUpdate.status = 'failed';
        orderUpdate.payment_status = 'failed';
        break;
      case 'CANCELLED':
        orderUpdate.status = 'cancelled';
        orderUpdate.payment_status = 'cancelled';
        break;
      default:
        orderUpdate.status = 'pending';
        orderUpdate.payment_status = 'pending';
    }

    // Update order in database (keep your existing Supabase code)
    const { data: updatedOrder, error } = await supabase
      .from('orders')
      .update(orderUpdate)
      .eq('id', orderId)
      .select()
      .single();

    if (error) throw error;

    if (orderUpdate.status === 'paid' || orderUpdate.status === 'processing') {
      await sendOrderConfirmation(updatedOrder);
      await updateInventory(updatedOrder.items);
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('IPN Processing Error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Helper functions (keep your existing implementations)
async function sendOrderConfirmation(order) {
  // Your email sending logic
}

async function updateInventory(items) {
  // Your inventory update logic
}

// Start server
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`SSLCommerz running in ${is_live ? 'LIVE PRODUCTION' : 'SANDBOX'} mode`);
});