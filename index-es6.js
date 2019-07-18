/* eslint-disable no-param-reassign */
/* eslint-disable func-names */
/* eslint-disable  no-underscore-dangle */
const _ = require('lodash');

const temporalDefaultOptions = {
  // runs the insert within the sequelize hook chain, disable
  // for increased performance
  blocking: true,
  full: false,
};


const excludeAttributes = function (obj, attrsToExclude) {
  // fancy way to exclude attributes
  return _.omit(obj, _.partial(_.rearg(_.includes, 0, 2, 1), attrsToExclude));
};

const calculatedFields = ['last_attempts', 'last_outbound_attempts', 'updated_at'];
const removeCalculated = obj => {
  const newObj = {};
  Object.keys(obj).forEach(k => {
    if (!calculatedFields.includes(k)) newObj[k] = obj[k];
  });
  return newObj;
};

const sortArrays = obj => (Array.isArray(obj) ? obj.sort() : obj);
// eslint-disable-next-line max-len
const convertStringToNumber = obj => (isNaN(parseInt(obj, 10)) || isNaN(Number(obj)) ? obj : Number(obj));
// eslint-disable-next-line max-len
const cleanupObj = obj => removeCalculated(Object.assign({}, ...Object.keys(obj).map(k => ({ [k]: sortArrays(convertStringToNumber(obj[k])) }))));
const validateUpdate = (obj, options, previous) => {
  if (!options || !options.allowEmptyUpdates) {
    let fields = Object.keys(obj._changed);
    fields = fields.length === 0 ? options.fields: fields;
    const previousValues = cleanupObj(_.pick(previous, fields));
    const newValues = cleanupObj(_.pick(obj.dataValues, fields));
    const change = !_.isEqual(newValues, previousValues);
    return change;
  }
  return true;
};

const Temporal = function (model, sequelize, temporalOptions) {
  // eslint-disable-next-line no-param-reassign
  temporalOptions = _.extend({}, temporalDefaultOptions, temporalOptions);
  const Sequelize = sequelize.Sequelize;
  const historyName = `${model.name}History`;
  // var historyName = model.getTableName() + 'History';
  // var historyName = model.options.name.singular + 'History';

  const historyOwnAttrs = {
    hid: {
      type: Sequelize.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      unique: true,
    },
    archivedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    },
    isCreate: {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    },
  };

  const excludedAttributes = ['Model', 'unique', 'primaryKey', 'autoIncrement', 'set', 'get', '_modelAttribute'];
  const historyAttributes = _(model.rawAttributes).mapValues((v) => {
    v = excludeAttributes(v, excludedAttributes);
    // remove the "NOW" defaultValue for the default timestamps
    // we want to save them, but just a copy from our master record
    if (v.fieldName === 'createdAt' || v.fieldName === 'updatedAt') {
      v.type = Sequelize.DATE;
    }
    return v;
  }).assign(historyOwnAttrs).value();
  // If the order matters, use this:
  // historyAttributes = _.assign({}, historyOwnAttrs, historyAttributes);

  const historyOwnOptions = {
    timestamps: false,
  };
  const excludedNames = ['name', 'tableName', 'sequelize', 'uniqueKeys', 'hasPrimaryKey', 'hooks', 'scopes', 'instanceMethods', 'defaultScope'];
  const modelOptions = excludeAttributes(model.options, excludedNames);
  const historyOptions = _.assign({}, modelOptions, historyOwnOptions);

  // We want to delete indexes that have unique constraint
  const indexes = historyOptions.indexes;
  if (Array.isArray(indexes)) {
    historyOptions.indexes = indexes.filter((index) => !index.unique && index.type != 'UNIQUE');
  }

  const modelHistory = sequelize.define(historyName, historyAttributes, historyOptions);
  
  const previousValue = async (obj, options) => {
    if (!options || !options.allowEmptyUpdates) {
      // Get previous values
      let fields = Object.keys(obj._changed);
      fields = fields.length === 0 ? options.fields: fields;
      const findParams = {};
      findParams.raw = true;
      findParams.where = { id: obj.dataValues.id };
      findParams.attributes = fields;
      let previousValues = await model.findOne(findParams);
      options.temporalPreviousValue = cleanupObj(previousValues);
    }
  };
  // we already get the updatedAt timestamp from our models
  const insertHook = (obj, options) => {
    const dataValues = (!temporalOptions.full && obj._previousDataValues) || obj.dataValues;
    const insertRecord = () => {
      const historyRecord = modelHistory.create(dataValues, { transaction: options.transaction });
      if (temporalOptions.blocking) {
        return historyRecord;
      }
      return {};
    };
    if (options && options.isCreate) {
      dataValues.isCreate = true;
      return insertRecord();
    }
    const change = validateUpdate(obj, options, options.temporalPreviousValue || {});
    if (change) {
      return insertRecord();
    }
    return {};
  };
  const previousValueBulk = (options) => {
    if (!options.individualHooks) {
      const queryAll = model.findAll({ where: options.where, transaction: options.transaction, raw: true }).then(async (hits) => {
        if (hits) {
          // Validate that there are changes
          options.temporalPreviousValue = {};
          hits.forEach((h) => { 
            options.temporalPreviousValue[h.id] = cleanupObj(h);
          });  
        }
      });
      if (temporalOptions.blocking) {
        return queryAll;
      }
    }
  };

  const insertBulkHook = function (options) {
    if (!options.individualHooks) {
      const queryAll = model.findAll({ where: options.where, transaction: options.transaction }).then((hits) => {
        if (hits) {
          // Validate that there are changes
          const newHits = [];
          for (let i = 0; i < hits.length; i += 1) {
            const hit = hits[i];
            if (validateUpdate(hit, options, options.temporalPreviousValue[hit.dataValues.id] || {})) newHits.push(hit);
          }
          if (newHits.length > 0) {
            hits = _.pluck(newHits, 'dataValues');
            hits = hits.map(hit => (Object.assign(hit, options.attributes)));
            return modelHistory.bulkCreate(hits, { transaction: options.transaction });
          }
        }
        return {};
      });
      if (temporalOptions.blocking) {
        return queryAll;
      }
    }
    return {};
  };


  const insertBulkCreateHook = function (instances, options) {
    if (!options.individualHooks) {
      const hits = instances.map(instance => (Object.assign(instance.dataValues, { isCreate: true })));
      if (hits) {
        return modelHistory.bulkCreate(hits, { transaction: options.transaction });
      }
    }
  };

  // use `after` to be nonBlocking
  // all hooks just create a copy
  if (temporalOptions.full) {
    model.hook('afterCreate', (obj, options) => insertHook(obj, Object.assign(options, { isCreate: true })));
    model.hook('afterBulkCreate', insertBulkCreateHook);
  }
  model.hook('beforeUpdate', previousValue);
  model.hook('beforeDestroy',  previousValue);
  model.hook('beforeBulkUpdate',  previousValueBulk);
  model.hook('beforeBulkDestroy', previousValueBulk);
  model.hook('afterUpdate', insertHook);
  model.hook('afterDestroy', insertHook);
  model.hook('afterBulkUpdate', insertBulkHook);
  model.hook('afterBulkDestroy', insertBulkHook);

  const readOnlyHook = function () {
    throw new Error("This is a read-only history database. You aren't allowed to modify it.");
  };

  modelHistory.hook('beforeUpdate', readOnlyHook);
  modelHistory.hook('beforeDestroy', readOnlyHook);

  return model;
};

module.exports = Temporal;