const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken')
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRETE_KEY);

const port = process.env.PORT || 5000;

//middle wire
app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.yllpa.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


function verifyJWT(req, res, next){
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({message: 'Unauthorized Access'})
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function(err, decoded){
        if (err) {
            return res.status(403).send({message: 'Forbidden Access'})
        }
        req.decoded = decoded;
        next();
    });

}
async function run() {
    try {
        await client.connect();
        const appointmentCollection = client.db("doctor's_portal").collection("appointments");
        const bookingCollection = client.db("doctor's_portal").collection("bookings");
        const userCollection = client.db("doctor's_portal").collection("users");
        const doctorsCollection = client.db("doctor's_portal").collection("doctors");
        const paymentCollection = client.db("doctor's_portal").collection("payments");

        // middlewire for varify is this user is admin or not 
        const verifyAdmin = async(req, res, next) => {
            const requester = req.decoded.email;
            const requesterAccount = await userCollection.findOne({email: requester});
            if (requesterAccount.role === 'admin') {
                next()
            }
            else{
                res.status(403).send({message:'Forbidden'})
            }
        }

        app.get('/allUser',verifyJWT, async(req, res)=>{
            const allUser = await userCollection.find().toArray();
            res.send(allUser);
        });

        app.put('/user/admin/:email' ,verifyJWT,verifyAdmin, async(req, res)=> {
            const email = req.params.email;            
            const filter = {email: email};
            const updatedDoc = {
                $set: {role: 'admin'},
            };
            const result = await userCollection.updateOne(filter, updatedDoc);
            console.log(email);
            res.send(result);
            
        });

        app.delete('/user/:email',  async(req, res)=>{
            const email = req.params.email;
            const filter = {email: email};
            const result = await userCollection.deleteOne(filter);
            res.send(result);
        })

        app.get('/admin/:email', async(req, res)=>{
            const email = req.params.email;
            const user = await userCollection.findOne({email: email })
            const isAdmin = user.role === 'admin';
            res.send({admin: isAdmin});
        })

        app.put('/user/:email', async(req, res)=> {
            const email = req.params.email;
            const user = req.body;
            const filter = {email: email};
            const options = {upsert: true};
            const updatedDoc = {
                $set: user,
            };
            const result = await userCollection.updateOne(filter, updatedDoc, options);
            const token = jwt.sign({email: email}, process.env.ACCESS_TOKEN , {expiresIn: '1d'});
            res.send({result, token});
        });

        


        app.get('/appointment', async(req, res)=> {
            const query = {};
            const cursor = appointmentCollection.find(query).project({name:1});
            const appointment = await cursor.toArray();
            res.send(appointment);
        })

        app.get('/available', async(req, res)=>{
            const date = req.query.date;

            // 1: get all appointment
            const appointments = await appointmentCollection.find().toArray();
            // 2: get booking on that day
            const query = {date: date};
            const bookings = await bookingCollection.find(query).toArray();
            // 3: for each appointements 
            appointments.forEach(appointment=> {
                // 4: find booking for that treatment(appoinment) 
                const appointmentBooking = bookings.filter(book => book.treatment === appointment.name);
                //5 : select slots for the treatment bookings ['','',''],
                const booked = appointmentBooking.map(s=> s.slot);

                // 6: select those slots that are not in booked 
                const available = appointment.slots.filter(s=> !booked.includes(s));
    
                //7: set available slots
                appointment.slots = available;
            })

            res.send(appointments);

        })


        app.get('/booking', verifyJWT ,async(req,res)=>{
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if (email === decodedEmail) {
            
            const query = {email : email};
            const authorization = req.headers.authorization;
            const booking = await bookingCollection.find(query).toArray();
            res.send(booking);
            }
        })

        app.get('/booking/:id', verifyJWT, async(req, res) =>{
            const id = req.params.id;
            const query = {_id: ObjectId(id)};
            const booking = await bookingCollection.findOne(query);
            res.send(booking);
        })

        app.post('/booking', async(req, res)=>{
            const booking = req.body;
            const query = { treatment: booking.treatment, date:booking.date, email: booking.email}
            const exists = await bookingCollection.findOne(query);
            if (exists) {
                return res.send({success: false, booking: exists})
            }
            const result = await bookingCollection.insertOne(booking);
            res.send({success:true , result});
        });
        //booking update after pay bill
        app.patch('/booking/:id', verifyJWT, async(req, res) =>{
            const id  = req.params.id;
            const payment = req.body;
            const filter = {_id: ObjectId(id)};
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                    }
                            }
                const result = await paymentCollection.insertOne(payment);
                const updatedBooking = await bookingCollection.updateOne(filter, updatedDoc);
                res.send(updatedBooking);
    });


        // doctors part
        app.get('/doctor', async(req, res)=>{
            const doctors = await doctorsCollection.find().toArray();
            res.send(doctors);
        })

        app.post('/doctor',verifyJWT, async(req, res)=>{
            const doctor = req.body;
            const result =await doctorsCollection.insertOne(doctor);
            res.send(result);
        });

        app.delete('/doctor/:email',verifyJWT, async(req, res)=>{
            const email = req.params.email;
            const filter = {email: email};
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        });

        // ==========PAYMENT===============
        app.post('/create-payment-intent', verifyJWT, async(req, res) =>{
            const myAppointment = req.body;
            const price = myAppointment.price;
            const amount = price*100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount : amount,
                currency: 'usd',
                payment_method_types:['card']
            });
            res.send({clientSecret: paymentIntent.client_secret})
            });

    } 
    
    finally {    }
}
run().catch(console.dir);


app.get('/' , (req, res) => {
    res.send("Doctor's Protal is Running")
})

app.listen(port,()=>{
    console.log('Doctors Portal :', port);
})
