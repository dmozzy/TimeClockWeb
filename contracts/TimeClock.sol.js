var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("TimeClock error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("TimeClock error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("TimeClock contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of TimeClock: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to TimeClock.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: TimeClock not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": false,
        "inputs": [],
        "name": "getNextPaymentDate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "paymentInterval",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "contractDetails",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "description",
            "type": "string"
          }
        ],
        "name": "purchase",
        "outputs": [],
        "payable": true,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "startTime",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "contractorWithdraw",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "contracteeWithdraw",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "minimumPayment",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "update",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "contractees",
        "outputs": [
          {
            "name": "addr",
            "type": "address"
          },
          {
            "name": "balance",
            "type": "uint256"
          },
          {
            "name": "description",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "paymentsCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "contracteesSize",
        "outputs": [
          {
            "name": "contracteesLocation",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "contractorBalance",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "amountInEscrow",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "currentPaymentsCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "contractorAddress",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "contractDetailsText",
            "type": "string"
          },
          {
            "name": "startDelayInSeconds",
            "type": "uint256"
          },
          {
            "name": "paymentIntervalInSeconds",
            "type": "uint256"
          },
          {
            "name": "numberOfPayments",
            "type": "uint256"
          },
          {
            "name": "minimumPaymentAmount",
            "type": "uint256"
          }
        ],
        "type": "constructor"
      },
      {
        "payable": false,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "from",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "Purchase",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "contractor",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ContracteeWithdraw",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "contractee",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "ContractorWithdraw",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "updator",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "escrowValue",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "paymentsCount",
            "type": "uint256"
          }
        ],
        "name": "UpdateTriggered",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x6060604052604051610c12380380610c1283398101604052805160805160a05160c05160e051939094019391929091908460076000509080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106100f457805160ff19168380011785555b506100969291505b808211156101245760008155600101610082565b505042840160015560048390556002829055600980546c0100000000000000000000000033810204600160a060020a031990911617905560006003819055600581905560065560088190555050505050610aea806101286000396000f35b8280016001018555821561007a579182015b8281111561007a578251826000505591602001919060010190610106565b509056606060405236156100c45760e060020a600035046309c12ccb81146101095780631cc1cf461461011657806339571d6e1461012457806359f5e0ce1461018957806378e97925146101ef5780637db12abc146101fd578063833938821461021657806394ef987e14610234578063a2e6204514610242578063a2f507ec14610265578063aafab1e81461029b578063b9a5e073146102a9578063ccc1b0cd146102ef578063d952d154146102fd578063de83aff51461030b578063f21376af14610319575b346100025761033060408051808201909152601781527f4e6f204465736372697074696f6e2070726f76696465640000000000000000006020820152610332906101d4565b3461000257610334610350565b346100025761033460045481565b346100025761036460078054604080516020601f600260001961010060018816150201909516949094049384018190048102820181019092528281529291908301828280156107575780601f1061072c57610100808354040283529160200191610757565b6103306004808035906020019082018035906020019191908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496505050505050505b600080548190819081908190819060ff161561048f57610002565b346100025761033460015481565b34610002576103306000805460ff161561075f57610002565b346100025761033060043560008054819060ff16156107fb57610002565b346100025761033460085481565b3461000257610330600080548190819081908190819060ff161561097e57610002565b34610002576103d2600435600a816064811015610002576003020180546001820154600160a060020a0390911692509060020183565b346100025761033460025481565b3461000257610334600080805b6064811015610ae4576000600a826064811015610002576003020154600160a060020a0316146102e7576001810191505b6001016102b6565b346100025761033460065481565b346100025761033460055481565b346100025761033460035481565b3461000257610473600954600160a060020a031681565b005b565b60408051918252519081900360200190f35b955042600f016109a85b600454600354600180549101909102015b90565b60405180806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156103c45780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b60408051600160a060020a038516815260208101849052606091810182815283546002600019610100600184161502019091160492820183905290916080830190849080156104625780601f1061043757610100808354040283529160200191610462565b820191906000526020600020905b81548152906001019060200180831161044557829003601f168201915b505094505050505060405180910390f35b60408051600160a060020a039092168252519081900360200190f35b6000805460ff19166001179055865160809011156104ac57610002565b6008543410156104bb57610002565b600254600354106104cb57610002565b6001955060009450600093505b6064841080156104e55750855b1561052057600a846064811015610002576003020160005060018101549093501515610515576000955092935083925b6001909301926104d8565b851561052b57610002565b6003546002540391506000821161054157610002565b81348115610002576005805492909104918201905560408051606081018252338152348390036020820152908101899052909150600a8660648110156100025760030201600050815181546c010000000000000000000000009182029190910473ffffffffffffffffffffffffffffffffffffffff19909116178155602080830151600180840191909155604084015180516002808601805460008281528790209196601f9682161561010002600019019091169290920485018290048101949293909291019083901061063857805160ff19168380011785555b506106689291505b808211156107285760008155600101610624565b8280016001018555821561061c579182015b8281111561061c57825182600050559160200191906001019061064a565b50509050507fd3aa7599e4b0c574b10dc23d7bf5acf28f2193861951c1ba95a90f8a68073fa03334896040518084600160a060020a03168152602001838152602001806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156107065780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a16000805460ff1916905550505050505050565b5090565b820191906000526020600020905b81548152906001019060200180831161073a57829003601f168201915b505050505081565b506000805460ff1916600117815560068054908290556009546040519192600160a060020a039091169183156108fc0291849190818181858888f1935050505015156107aa57610002565b60408051600160a060020a03331681526020810183905281517f9ee74b2e5c9c32f5affb01e4a665ed8b05aa66a94c6259ff3a413ba70499fadf929181900390910190a16000805460ff1916905550565b6000805460ff19166001179055600a8360648110156100025760030201805490925033600160a060020a03908116911614801590610848575060095433600160a060020a03908116911614155b1561085257610002565b600182015460009011156108dd575060018101805460009182905582546040519192600160a060020a039091169183156108fc0291849190818181858888f1935050505015156108ec57610002565b820191906000526020600020905b8154815290600101906020018083116108af57829003601f168201915b505094505050505060405180910390a15b6000805460ff19169055505050565b6040805133600160a060020a0381168252602082018490526060928201838152600286810180546001811615610100026000190116919091049484018590527f95412debe4ec1d1cf13609e6c96492f955bc23974161d64247ccf981341df9df9492938693919290916080830190849080156108cc5780601f106108a1576101008083540402835291602001916108cc565b6000805460ff19166001179055610346600454600154600091904203811561000257049050610361565b11156109b357610002565b600254600354106109e85760095433600160a060020a03908116911614156109e357600954600160a060020a0316ff5b610002565b600354861115610a8257600380546001810190915560025460058054600680549091019055600090819055919003600019019550851115610a8257600093505b6064841015610a8257600a8460648110156100025760030201600050600181015490935091506000821115610a7757848281156100025760058054929091049182019055808303600185015590505b600190930192610a28565b60055460035460408051600160a060020a0333168152602081019390935282810191909152517fa5d33470d7958ab601ccc783060f40bb2cc52d05bdf8e758579ec953e6a884e59181900360600190a16000805460ff19169055505050505050565b5091905056",
    "events": {
      "0x2499a5330ab0979cc612135e7883ebc3cd5c9f7a8508f042540c34723348f632": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Purchase",
        "type": "event"
      },
      "0x7cdb51e9dbbc205231228146c3246e7f914aa6d4a33170e43ecc8e3593481d1a": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_message",
            "type": "string"
          }
        ],
        "name": "Debug",
        "type": "event"
      },
      "0xfe21d906fe8f9cb518acfb8fea459e46c0a002420b1bc546b1d53a2424020c3e": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "_message",
            "type": "string"
          },
          {
            "indexed": false,
            "name": "_val",
            "type": "uint256"
          }
        ],
        "name": "DebugInt",
        "type": "event"
      },
      "0xd3aa7599e4b0c574b10dc23d7bf5acf28f2193861951c1ba95a90f8a68073fa0": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "from",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "Purchase",
        "type": "event"
      },
      "0x3c5ad147104e56be34a9176a6692f7df8d2f4b29a5af06bc6b98970d329d6577": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "message",
            "type": "string"
          },
          {
            "indexed": false,
            "name": "number",
            "type": "uint256"
          }
        ],
        "name": "Debug",
        "type": "event"
      },
      "0x95412debe4ec1d1cf13609e6c96492f955bc23974161d64247ccf981341df9df": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "contractor",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "description",
            "type": "string"
          }
        ],
        "name": "ContracteeWithdraw",
        "type": "event"
      },
      "0x9ee74b2e5c9c32f5affb01e4a665ed8b05aa66a94c6259ff3a413ba70499fadf": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "contractee",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "ContractorWithdraw",
        "type": "event"
      },
      "0xa5d33470d7958ab601ccc783060f40bb2cc52d05bdf8e758579ec953e6a884e5": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "updator",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "escrowValue",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "paymentsCount",
            "type": "uint256"
          }
        ],
        "name": "UpdateTriggered",
        "type": "event"
      }
    },
    "updated_at": 1479253910457,
    "address": "0xa805e4058caa8140792757fb7e7d4f4c294d0aa8",
    "links": {}
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "TimeClock";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.TimeClock = Contract;
  }
})();
