
var comp = app.project.activeItem;
var str = '';
try {
if (comp && comp.layers.length > 0) {
  var prop = comp.layer(1).property('Contents').property(1).property('Contents').property('Gradient Fill 1').property('Colors');
  if (prop) {
    str = 'GRADIENT: ' + prop.value.join(', ');
  } else {
    str = 'Gradient fill not found';
  }
} else {
  str = 'No active comp with a layer';
}
} catch(e) {
  str = 'Error: ' + e.toString();
}
var f = new File('c:/Users/aldai/OneDrive/Documentos/_motion_toolbar_plugin/motion-toolbar/ae_grad_test.txt');
f.open('w');
f.write(str);
f.close();

