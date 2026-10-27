// The in-memory evaluator of Mongo's query and pipeline language that lib/docdb/model.js loads where SQL can't answer (a residual filter, an update
// given as a pipeline, a sub-pipeline of $lookup, an aggregation). The package's own entry point registers all of its operators, 750 KB of the Worker
// in the two layers of Next.js's build, nearly all of them (trigonometry, windows, bit operations, set and string functions…) never asked for. This
// registers the operators the code names. tests/mingo-engine.test.mjs reads every `$operator` in the source and fails when mingo has one that is
// not registered here, so a new operator in a query or a pipeline is a line below, not a failure in production.
import { Aggregator as AggregatorBase } from "mingo/aggregator";
import { Context } from "mingo/core";
import { Query as QueryBase } from "mingo/query";
import { $addToSet, $count as $countAccumulator, $first as $firstAccumulator, $max, $min, $push, $sum } from "mingo/operators/accumulator";
import {
	$abs,
	$add,
	$and as $andExpression,
	$cond,
	$dateToString,
	$eq as $eqExpression,
	$first as $firstExpression,
	$gt as $gtExpression,
	$gte as $gteExpression,
	$hour,
	$ifNull,
	$in as $inExpression,
	$lt as $ltExpression,
	$lte as $lteExpression,
	$ne as $neExpression,
	$not as $notExpression,
	$or as $orExpression,
	$subtract,
	$type as $typeExpression,
} from "mingo/operators/expression";
import { $addFields, $count as $countStage, $group, $limit, $match, $project, $set, $sort, $unset, $unwind } from "mingo/operators/pipeline";
import { $all, $and, $elemMatch, $eq, $exists, $expr, $gt, $gte, $in, $lt, $lte, $ne, $nin, $nor, $not, $or, $regex, $type } from "mingo/operators/query";

export const OPERATORS = {
	accumulator: { $addToSet, $count: $countAccumulator, $first: $firstAccumulator, $max, $min, $push, $sum },
	expression: {
		$abs,
		$add,
		$and: $andExpression,
		$cond,
		$dateToString,
		$eq: $eqExpression,
		$first: $firstExpression,
		$gt: $gtExpression,
		$gte: $gteExpression,
		$hour,
		$ifNull,
		$in: $inExpression,
		$lt: $ltExpression,
		$lte: $lteExpression,
		$ne: $neExpression,
		$not: $notExpression,
		$or: $orExpression,
		$subtract,
		$type: $typeExpression,
	},
	pipeline: { $addFields, $count: $countStage, $group, $limit, $match, $project, $set, $sort, $unset, $unwind },
	query: { $all, $and, $elemMatch, $eq, $exists, $expr, $gt, $gte, $in, $lt, $lte, $ne, $nin, $nor, $not, $or, $regex, $type },
};

const CONTEXT = Context.init(OPERATORS);

export class Query extends QueryBase {
	constructor(condition, options) {
		super(condition, { ...options, context: CONTEXT });
	}
}

export class Aggregator extends AggregatorBase {
	constructor(pipeline, options) {
		super(pipeline, { ...options, context: CONTEXT });
	}
}
