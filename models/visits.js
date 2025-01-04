const mongoose = require('mongoose')
const AutoIncrement = require('mongoose-sequence')(mongoose);

const visitsSchema = new mongoose.Schema({
  id: Number,
  num_visits: Number
})

visitsSchema.plugin(AutoIncrement, {inc_field: 'id', start_seq: 1, id: 'visits_id_counter'});

visitsSchema.set('toJSON', {
  transform: (document, returnedObject) => {
    returnedObject.id = returnedObject.id || returnedObject._id;
    delete returnedObject._id;
    delete returnedObject.__v;
  }
})

module.exports = mongoose.model('Visits', visitsSchema)