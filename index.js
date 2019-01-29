var _ = require('lodash');

var temporalDefaultOptions = {
  // runs the insert within the sequelize hook chain, disable
  // for increased performance
  blocking: true,
  full: false
};

var excludeAttributes = function(obj, attrsToExclude){
  // fancy way to exclude attributes
  return _.omit(obj, _.partial(_.rearg(_.contains,0,2,1), attrsToExclude));
}

var Temporal = function(model, sequelize, temporalOptions){
  temporalOptions = _.extend({},temporalDefaultOptions, temporalOptions);

  var Sequelize = sequelize.Sequelize;

  var historyName = model.name + 'History';
  //var historyName = model.getTableName() + 'History';
  //var historyName = model.options.name.singular + 'History';

  var historyOwnAttrs = {
    hid: {
      type:          Sequelize.BIGINT,
      primaryKey:    true,
      autoIncrement: true,
      unique: true
    },
    archivedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW
    },
    isCreate: {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    },
  };

  var excludedAttributes = ["Model","unique","primaryKey","autoIncrement", "set", "get", "_modelAttribute"];
  var historyAttributes = _(model.rawAttributes).mapValues(function(v){
    v = excludeAttributes(v, excludedAttributes);
    // remove the "NOW" defaultValue for the default timestamps
    // we want to save them, but just a copy from our master record
    if(v.fieldName == "createdAt" || v.fieldName == "updatedAt"){
      v.type = Sequelize.DATE;
    }
    return v;
  }).assign(historyOwnAttrs).value();
  // If the order matters, use this:
  //historyAttributes = _.assign({}, historyOwnAttrs, historyAttributes);

  var historyOwnOptions = {
    timestamps: false
  };
  var excludedNames = ["name", "tableName", "sequelize", "uniqueKeys", "hasPrimaryKey", "hooks", "scopes", "instanceMethods", "defaultScope"];
  var modelOptions = excludeAttributes(model.options, excludedNames);
  var historyOptions = _.assign({}, modelOptions, historyOwnOptions);
  
  // We want to delete indexes that have unique constraint
  var indexes = historyOptions.indexes;
  if(Array.isArray(indexes)){
     historyOptions.indexes = indexes.filter(function(index){return !index.unique && index.type != 'UNIQUE';});
  }

  var modelHistory = sequelize.define(historyName, historyAttributes, historyOptions);

  // we already get the updatedAt timestamp from our models
  var insertHook = function(obj, options){
    var dataValues = (!temporalOptions.full && obj._previousDataValues) || obj.dataValues;
    if(options && options.isCreate) {
      dataValues.isCreate = true;
    }
    var historyRecord = modelHistory.create(dataValues, {transaction: options.transaction});
    if(temporalOptions.blocking){
      return historyRecord;
    }
  }
  var insertBulkHook = function(options){
    if(!options.individualHooks){
      var queryAll = model.findAll({where: options.where, transaction: options.transaction}).then(function(hits){
        if(hits){
          hits = _.pluck(hits, 'dataValues');
          return modelHistory.bulkCreate(hits, {transaction: options.transaction});
        }
      });
      if(temporalOptions.blocking){
        return queryAll;
      }
    }
  }

  // use `after` to be nonBlocking
  // all hooks just create a copy
  if (temporalOptions.full) {
    model.hook('afterCreate', (obj, options) => {
      return insertHook(obj, { ...options, isCreate: true, });
    });
    model.hook('afterUpdate', insertHook);
    model.hook('afterDestroy', insertHook);
    model.hook('afterRestore', insertHook);
  } else {
    model.hook('beforeUpdate', insertHook);
    model.hook('beforeDestroy', insertHook);
  }

  model.hook('beforeBulkUpdate', insertBulkHook);
  model.hook('beforeBulkDestroy', insertBulkHook);

  var readOnlyHook = function(){
    throw new Error("This is a read-only history database. You aren't allowed to modify it.");    
  };

  modelHistory.hook('beforeUpdate', readOnlyHook);
  modelHistory.hook('beforeDestroy', readOnlyHook);

  return model;
};

module.exports = Temporal;
